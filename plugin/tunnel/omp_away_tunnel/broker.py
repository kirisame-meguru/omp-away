"""One paired gateway per private state directory; local sessions keep their own authority."""
import asyncio
import errno
import hashlib
import hmac
import json
import os
import secrets
import struct
import subprocess
import sys
import time
from pathlib import Path

from .identity import digest_bytes, locked, private_directory, read_private_json, write_private_json
from .ipc import IPC_JSON_LIMIT, decode_frame, frame_size
from .preferences import load_preferences, patch_preferences, save_preferences
from .transport import HEADER, JSON_LIMIT, ProtocolError, encode, object_json


ENDPOINT = 'gateway.json'
MAX_CLIENTS = 32
MAX_PENDING = 128


def configuration(init):
    digest_bytes(init['desktopToken'])
    return hashlib.sha256(encode({'url': init['url'].rstrip('/'), 'token': init['desktopToken']})).hexdigest()


async def read_frame(reader):
    kind, size = HEADER.unpack(await reader.readexactly(5))
    frame_size(kind, size)
    return kind, await reader.readexactly(size)


def send_frame(writer, kind, data):
    frame_size(kind, len(data))
    if writer.is_closing() or writer.transport.get_write_buffer_size() > 4 * IPC_JSON_LIMIT:
        writer.close()
        raise ConnectionError('local gateway backpressure')
    writer.write(HEADER.pack(kind, len(data)) + data)


class Client:
    def __init__(self, writer):
        self.writer = writer
        self.inboxes = {}
        self.pending = set()
        self.confirmations = set()
        self.routing = False

    def event(self, **msg):
        self.send(1, encode(msg))

    def send(self, kind, data):
        try:
            send_frame(self.writer, kind, data)
        except (ValueError, ConnectionError):
            self.writer.close()


class Broker:
    def __init__(self, init):
        self.init = init
        self.auth = secrets.token_urlsafe(32)
        self.config = configuration(init)
        self.directory = Path(init['stateDir'])
        self.preferences = {}
        self.routing_lock = asyncio.Lock()
        self.commands = asyncio.Queue(maxsize=MAX_CLIENTS * MAX_PENDING)
        self.clients = set()
        self.pending = {}
        self.active = {}
        self.pair_owner = None
        self.pair_pending = False
        self.sequence = 0
        self.ready = False
        self.stopping = False
        self.idle = None
        self.tasks = set()
        self.service = None

    async def read(self):
        while True:
            command = await self.commands.get()
            if command['op'] == 'close':
                return command
            client, local, op, authority = self.pending[command['id']]
            if client is not None and (client not in self.clients or
                    authority is not None and authority is not self.active.get(command.get('deviceId'))):
                await self.event(event='reply', id=command['id'], ok=False)
                continue
            return command

    async def enqueue(self, client, command):
        if client is not None and (self.commands.full() or len(client.pending) >= MAX_PENDING):
            raise ProtocolError('local gateway busy')
        local = command.get('id', 0)
        if client is not None and local in client.pending:
            raise ProtocolError('duplicate local command')
        self.sequence = self.sequence % 0xffffffff + 1
        while self.sequence in self.pending:
            self.sequence = self.sequence % 0xffffffff + 1
        call_control = command['op'] == 'pcm' or command['op'] == 'control' and command['message']['type'] != 'inbox'
        authority = self.active.get(command.get('deviceId')) if client is not None and call_control else None
        self.pending[self.sequence] = (client, local, command['op'], authority)
        if client is not None:
            client.pending.add(local)
        await self.commands.put({**command, 'id': self.sequence})

    def inbox(self, device, replacement=None):
        items = []
        owners = set()
        for client in self.clients:
            incoming = replacement[1] if replacement and replacement[0] is client else client.inboxes.get(device, [])
            for item in incoming:
                if item['requestId'] in owners:
                    raise ProtocolError('duplicate request owner')
                owners.add(item['requestId'])
                items.append(item)
        items.sort(key=lambda item: (item['createdAt'], item['requestId']))
        message = {'type': 'inbox', 'items': items}
        if len(encode(message)) > JSON_LIMIT:
            raise ProtocolError('combined inbox too large')
        return message

    def owner(self, device, request):
        return next((client for client in self.clients if any(item['requestId'] == request for item in client.inboxes.get(device, []))), None)

    async def routing(self, client, cmd):
        if not cmd.keys() <= {'op', 'id', 'patch'}:
            raise ProtocolError('invalid routing command')
        async with self.routing_lock:
            if client not in self.clients:
                return
            next_preferences = patch_preferences(self.preferences, cmd.get('patch', {}))
            changed = next_preferences != self.preferences
            if changed:
                # Shutdown must drain an in-flight atomic write before releasing
                # gateway.lock, or a replacement broker could read stale state.
                write = asyncio.create_task(asyncio.to_thread(save_preferences, self.directory, next_preferences))
                try:
                    await asyncio.shield(write)
                except asyncio.CancelledError:
                    await write
                    raise
                self.preferences = next_preferences
            client.routing = True
            for recipient in tuple(self.clients):
                if recipient.routing and (changed or recipient is client):
                    recipient.event(event='routing', preferences=self.preferences)
            client.event(event='reply', id=cmd['id'], ok=True, value=self.preferences)

    async def command(self, client, cmd):
        if not isinstance(cmd, dict) or type(cmd.get('id')) is not int or not 0 < cmd['id'] < 2**32:
            raise ProtocolError('invalid command id')
        op = cmd.get('op')
        if op not in ('devices', 'pair', 'ring', 'confirm', 'control', 'pcm', 'routing'):
            raise ProtocolError('invalid session operation')
        if cmd['id'] in client.pending:
            raise ProtocolError('duplicate local command')
        try:
            if self.commands.full() or len(client.pending) >= MAX_PENDING:
                raise ProtocolError('local gateway busy')
            if op == 'routing':
                await self.routing(client, cmd)
                return
            if op == 'pair':
                if self.pair_pending or self.pair_owner not in (None, client) and (self.service.pairs.available() or self.service.waiters):
                    raise ProtocolError('enrollment owned by another session')
                self.pair_owner = client
                self.pair_pending = True
            elif op == 'ring':
                if self.owner(cmd.get('deviceId'), cmd.get('requestId')) not in (None, client):
                    raise ProtocolError('unowned request')
            elif op == 'confirm':
                if cmd.get('ref') not in client.confirmations:
                    raise ProtocolError('unowned confirmation')
                client.confirmations.remove(cmd['ref'])
            elif op in ('control', 'pcm'):
                device = cmd.get('deviceId')
                phone = self.service.phones.get(device)
                if phone is None or cmd.get('ref') != phone.ref:
                    raise ProtocolError('stale phone')
                message = cmd.get('message')
                if op == 'control' and isinstance(message, dict) and message.get('type') == 'inbox':
                    phone.outgoing(message)  # Inbox validation does not mutate call state.
                    merged = self.inbox(device, (client, message['items']))
                    client.inboxes[device] = message['items']
                    cmd = {**cmd, 'message': merged}
                else:
                    active = self.active.get(device)
                    if active is None or active[0] is not client:
                        raise ProtocolError('unowned call')
                    if op == 'control':
                        if not isinstance(message, dict) or message.get('type') not in ('joined', 'ended', 'mark', 'transcript', 'error'):
                            raise ProtocolError('invalid call control')
                        if message['type'] != 'error' and message.get('requestId') != active[1]:
                            raise ProtocolError('stale call')
            await self.enqueue(client, cmd)
        except (ValueError, KeyError, TypeError, OSError):
            client.event(event='reply', id=cmd['id'], ok=False)

    async def event(self, **msg):
        event = msg['event']
        if event == 'reply':
            pending = self.pending.pop(msg['id'], None)
            if pending:
                client, local, op, authority = pending
                if op == 'pair':
                    self.pair_pending = False
                    if client not in self.clients:
                        self.service.pairs.offer = None
                        self.service.pairs.generation += 1
                if client in self.clients:
                    client.pending.discard(local)
                    client.event(**{**msg, 'id': local})
            return
        if event == 'ready':
            self.ready = True
            msg = {**msg, 'routingVersion': 1}
        elif event == 'confirm':
            client = self.pair_owner
            if client in self.clients:
                client.confirmations.add(msg['ref'])
                client.event(**msg)
            else:
                await self.enqueue(None, {'op': 'confirm', 'ref': msg['ref'], 'accept': False})
            return
        elif event == 'message':
            device, message = msg['deviceId'], msg['message']
            if message['type'] != 'list':
                request = message.get('requestId')
                active = self.active.get(device)
                client = active[0] if message['type'] != 'join' and active and active[1] == request else self.owner(device, request)
                if message['type'] == 'join':
                    if client is None:
                        await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': msg['ref'], 'message': {'type': 'error', 'code': 'request-unavailable'}})
                        return
                    # Phone.incoming already excludes simultaneous calls. Retain this
                    # owner through ended -> error; each join creates a new authority.
                    self.active[device] = (client, request)
                if client in self.clients:
                    client.event(**msg)
                return
        elif event == 'lost':
            self.active.pop(msg['deviceId'], None)
            for client in self.clients:
                client.inboxes.pop(msg['deviceId'], None)
        for client in tuple(self.clients):
            client.event(**msg)

    async def media(self, device, ref, pcm):
        active = self.active.get(device)
        if active and active[0] in self.clients:
            # Use the same routing envelope as the established stdio protocol.
            route = device.encode('ascii')
            active[0].send(2, struct.pack('!IB', 0, len(route)) + route + bytes.fromhex(ref) + pcm)

    async def detach(self, client):
        if client not in self.clients:
            return
        self.clients.remove(client)
        client.writer.close()
        if self.stopping:
            return
        for ref in client.confirmations:
            waiter = self.service.waiters.get(ref)
            if waiter is not None and not waiter.done():
                waiter.set_result(False)
        if self.pair_owner is client:
            self.pair_owner = None
            self.service.pairs.offer = None
            self.service.pairs.generation += 1
        for device, (owner, request) in tuple(self.active.items()):
            if owner is client:
                self.active.pop(device)
                phone = self.service.phones.get(device)
                if phone and request in (phone.joining, phone.joined):
                    await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref, 'message': {'type': 'ended', 'requestId': request}})
        for device in client.inboxes:
            phone = self.service.phones.get(device)
            if phone:
                await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref, 'message': self.inbox(device)})
        if not self.clients and not self.stopping:
            self.idle = asyncio.get_running_loop().call_later(10, self.stop)

    def stop(self):
        if not self.stopping:
            self.stopping = True
            if self.commands.full():
                self.commands.get_nowait()  # Shutdown has no remaining client to reply to.
            self.commands.put_nowait({'op': 'close'})

    async def accept(self, reader, writer):
        client = Client(writer)
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            async with asyncio.timeout(3):
                kind, data = await read_frame(reader)
                hello = object_json(data) if kind == 1 else None
                if (self.stopping or len(self.tasks) > MAX_CLIENTS or not isinstance(hello, dict) or
                        hello.keys() != {'auth', 'config'} or not isinstance(hello['auth'], str) or
                        not hmac.compare_digest(hello['auth'], self.auth) or hello['config'] != self.config):
                    raise ProtocolError('local authentication failed')
            send_frame(writer, 1, encode({'ok': True}))
            if self.idle:
                self.idle.cancel()
                self.idle = None
            self.clients.add(client)
            if self.ready:
                client.event(event='ready', routingVersion=1)
                for device, phone in self.service.phones.items():
                    client.event(event='connected', deviceId=device, ref=phone.ref)
            while True:
                kind, data = await read_frame(reader)
                cmd = decode_frame(kind, data)
                if isinstance(cmd, dict) and cmd.get('op') == 'close':
                    break
                await self.command(client, cmd)
        except (ValueError, KeyError, TypeError, ConnectionError, asyncio.IncompleteReadError, TimeoutError):
            pass
        finally:
            await self.detach(client)
            writer.close()
            try:
                async with asyncio.timeout(2):
                    await writer.wait_closed()
            except (ConnectionError, TimeoutError):
                pass
            self.tasks.discard(task)

    async def run(self, service):
        self.service = service
        directory = Path(self.init['stateDir'])
        private_directory(directory)
        endpoint = directory / ENDPOINT
        with locked(directory, 'gateway.lock'):
            self.preferences = load_preferences(directory)
            server = await asyncio.start_server(self.accept, '127.0.0.1', 0, limit=IPC_JSON_LIMIT + 5)
            try:
                write_private_json(endpoint, {'v': 1, 'port': server.sockets[0].getsockname()[1], 'auth': self.auth, 'config': self.config})
                self.idle = asyncio.get_running_loop().call_later(20, self.stop)
                await service.run()
            finally:
                self.stopping = True
                if self.idle:
                    self.idle.cancel()
                server.close()
                await server.wait_closed()
                for task in tuple(self.tasks):
                    task.cancel()
                await asyncio.gather(*self.tasks, return_exceptions=True)
                endpoint.unlink(missing_ok=True)


async def connect_local(init):
    endpoint = Path(init['stateDir']) / ENDPOINT
    saved = read_private_json(endpoint, 4096)
    if not isinstance(saved, dict) or saved.keys() != {'v', 'port', 'auth', 'config'} or saved['v'] != 1:
        raise ProtocolError('invalid local gateway endpoint')
    if type(saved['port']) is not int or not 0 < saved['port'] <= 65535 or saved['config'] != configuration(init):
        raise ProtocolError('local gateway configuration conflict')
    digest_bytes(saved['auth'])
    reader, writer = await asyncio.open_connection('127.0.0.1', saved['port'], limit=IPC_JSON_LIMIT + 5)
    try:
        async with asyncio.timeout(3):
            send_frame(writer, 1, encode({'auth': saved['auth'], 'config': saved['config']}))
            kind, data = await read_frame(reader)
            if kind != 1 or json.loads(data) != {'ok': True}:
                raise ProtocolError('local gateway authentication failed')
        return reader, writer
    except BaseException:
        writer.close()
        await writer.wait_closed()
        raise


def spawn_daemon(init):
    options = {'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
    child = subprocess.Popen([sys.executable, '-I', '-m', 'omp_away_tunnel', '--broker'], stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, **options)
    data = encode(init)
    child.stdin.write(HEADER.pack(1, len(data)) + data)
    child.stdin.close()
    return child


async def connect_shared(init):
    directory = Path(init['stateDir'])
    private_directory(directory)
    deadline = time.monotonic() + 20
    while True:
        try:
            return await connect_local(init)
        except (FileNotFoundError, ConnectionError, asyncio.IncompleteReadError):
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError('local gateway unavailable')
        election = locked(directory, 'gateway-start.lock')
        try:
            election.__enter__()
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN):
                raise
            await asyncio.sleep(.05)
            continue
        try:
            try:
                return await connect_local(init)
            except (FileNotFoundError, ConnectionError, asyncio.IncompleteReadError):
                pass
            child = spawn_daemon(init)
            while child.poll() is None and time.monotonic() < deadline:
                try:
                    return await connect_local(init)
                except (FileNotFoundError, ConnectionError, asyncio.IncompleteReadError):
                    await asyncio.sleep(.05)
            if child.poll() is None:
                child.terminate()
            raise ProtocolError('local gateway startup failed')
        finally:
            election.__exit__(None, None, None)


async def proxy(ipc, init):
    reader, writer = await connect_shared(init)
    async def upstream():
        while True:
            kind, data = await ipc.read_frame()
            send_frame(writer, kind, data)
            await writer.drain()
    async def downstream():
        while True:
            kind, data = await read_frame(reader)
            await ipc.write(kind, data)
    tasks = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (EOFError, asyncio.IncompleteReadError, ConnectionError):
        await ipc.event(event='fatal', code='shared_gateway_disconnected')
    finally:
        for task in tasks:
            task.cancel()
        writer.close()
        await asyncio.gather(*tasks, return_exceptions=True)
        await writer.wait_closed()
