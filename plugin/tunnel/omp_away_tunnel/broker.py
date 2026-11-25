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
from .controls import inbox_ids, question_display, text


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
        self.details = {}
        self.audience = set()  # Opaque (device, request) pairs survive phone disconnect.
        self.retiring = {}
        self.pending = set()
        self.confirmations = set()
        self.routing = False
        self.health = False

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
        self.touch = {}
        self.proposals = {}
        self.snapshots = {}
        self.snapshot_tasks = set()
        self.pair_owner = None
        self.pair_pending = False
        self.sequence = 0
        self.ready = False
        self.relay_connected = False
        self.stopping = False
        self.idle = None
        self.tasks = set()
        self.service = None

    async def begin_snapshot(self, device, ref):
        previous = self.snapshots.pop(device, None)
        if previous:
            previous['timer'].cancel()
        snapshot = {'ref': ref, 'waiting': set(self.clients), 'failed': False}
        self.snapshots[device] = snapshot
        for client in self.clients:
            client.details.pop(device, None)
        async def timeout():
            try:
                await asyncio.sleep(5)
                await self.fail_snapshot(device, snapshot, 'inbox-unavailable')
            finally:
                self.snapshot_tasks.discard(asyncio.current_task())
        snapshot['timer'] = asyncio.create_task(timeout())
        self.snapshot_tasks.add(snapshot['timer'])
        await self.finish_snapshot(device)

    async def fail_snapshot(self, device, snapshot, code):
        if self.snapshots.get(device) is not snapshot or snapshot['failed']:
            return
        snapshot['failed'] = True
        if snapshot['timer'] is not asyncio.current_task():
            snapshot['timer'].cancel()
        await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': snapshot['ref'],
                                 'message': {'type': 'error', 'code': code}})

    async def finish_snapshot(self, device):
        snapshot = self.snapshots.get(device)
        if not snapshot or snapshot['waiting'] or snapshot['failed']:
            return
        phone = self.service.phones.get(device)
        if phone is None or phone.ref != snapshot['ref']:
            return
        try:
            message = self.inbox(device)
        except ProtocolError:
            await self.fail_snapshot(device, snapshot, 'inbox-too-large')
            return
        self.snapshots.pop(device)
        snapshot['timer'].cancel()
        await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref, 'message': message})
        await self.replay_details(device, phone)

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
        call_control = command['op'] == 'pcm' or command['op'] == 'control' and command['message']['type'] not in ('inbox', 'question', 'form', 'answer')
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
        if op not in ('devices', 'pair', 'ring', 'invalidate', 'confirm', 'control', 'pcm', 'routing', 'health'):
            raise ProtocolError('invalid session operation')
        if cmd['id'] in client.pending:
            raise ProtocolError('duplicate local command')
        try:
            replay = None
            if self.commands.full() or len(client.pending) >= MAX_PENDING:
                raise ProtocolError('local gateway busy')
            if op == 'health':
                if cmd.keys() != {'op', 'id'}:
                    raise ProtocolError('invalid health command')
                client.health = True
                client.event(event='health', relayConnected=self.relay_connected)
                client.event(event='reply', id=cmd['id'], ok=True, value=None)
                return
            if op == 'routing':
                await self.routing(client, cmd)
                return
            if op == 'pair':
                if self.pair_pending or self.pair_owner not in (None, client) and (self.service.pairs.available() or self.service.waiters):
                    raise ProtocolError('enrollment owned by another session')
                self.pair_owner = client
                self.pair_pending = True
            elif op in ('ring', 'invalidate'):
                if cmd.keys() != {'op', 'id', 'deviceId', 'requestId'}:
                    raise ProtocolError('invalid wakeup')
                pair = (cmd['deviceId'], cmd['requestId'])
                if (self.owner(*pair) not in (None, client) or
                        any(pair in other.audience for other in self.clients if other is not client)):
                    raise ProtocolError('unowned request')
                if op == 'ring':
                    client.audience.add(pair)
                else:
                    client.retiring[cmd['id']] = pair
            elif op == 'confirm':
                if cmd.get('ref') not in client.confirmations:
                    raise ProtocolError('unowned confirmation')
                client.confirmations.remove(cmd['ref'])
            elif op in ('control', 'pcm'):
                device = cmd.get('deviceId')
                phone = self.service.phones.get(device)
                if phone is None or cmd.get('ref') != phone.ref:
                    raise ProtocolError('stale phone')
                snapshot = self.snapshots.get(device)
                message = cmd.get('message')
                if op == 'control' and isinstance(message, dict) and message.get('type') == 'inbox':
                    ids = inbox_ids(message)
                    if snapshot:
                        if snapshot['failed'] or any(self.owner(device, request) not in (None, client) for request in ids):
                            raise ProtocolError('snapshot unavailable')
                    else:
                        try:
                            merged = self.inbox(device, (client, message['items']))
                        except ProtocolError as error:
                            if str(error) == 'combined inbox too large':
                                await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref,
                                                         'message': {'type': 'error', 'code': 'inbox-too-large'}})
                            raise
                    client.inboxes[device] = message['items']
                    proposal = self.proposals.get(device)
                    if proposal and proposal[0] is client and proposal[1]['requestId'] not in ids:
                        self.proposals.pop(device, None)
                    client.details.pop(device, None)  # Replaced by this owner's fresh per-request frames.
                    client.audience.update((device, request) for request in ids)
                    if snapshot:
                        snapshot['waiting'].discard(client)
                        client.event(event='reply', id=cmd['id'], ok=True, value=None)
                        await self.finish_snapshot(device)
                        return
                    cmd = {**cmd, 'message': merged}
                    replay = (device, phone)
                elif op == 'control' and isinstance(message, dict) and message.get('type') in ('form', 'answer'):
                    # The source can remove its inbox entry before returning the canonical receipt.
                    key = (device, phone.ref, message.get('requestId'), message['type'])
                    if self.touch.get(key) is not client:
                        raise ProtocolError('unowned answer')
                    phone.outgoing(message)
                    del self.touch[key]
                elif op == 'control' and isinstance(message, dict) and message.get('type') == 'question':
                    if (message.keys() != {'type', 'requestId', 'display'} or not phone.details or
                            self.owner(device, message.get('requestId')) is not client or not question_display(message['display'])):
                        raise ProtocolError('unowned question metadata')
                    client.details.setdefault(device, {})[message['requestId']] = message
                    if snapshot:
                        if snapshot['failed']:
                            raise ProtocolError('snapshot unavailable')
                        client.event(event='reply', id=cmd['id'], ok=True, value=None)
                        return
                elif op == 'control' and message == {'type': 'error', 'code': 'inbox-too-large'}:
                    if snapshot:
                        await self.fail_snapshot(device, snapshot, 'inbox-too-large')
                        client.event(event='reply', id=cmd['id'], ok=True, value=None)
                        return
                else:
                    active = self.active.get(device)
                    if active is None or active[0] is not client:
                        raise ProtocolError('unowned call')
                    if op == 'control':
                        if not isinstance(message, dict) or message.get('type') not in ('joined', 'ended', 'mark', 'transcript', 'proposal', 'error'):
                            raise ProtocolError('invalid call control')
                        if message['type'] != 'error' and message.get('requestId') != active[1]:
                            raise ProtocolError('stale call')
                        if message['type'] == 'proposal':
                            if (message.keys() != {'type', 'requestId', 'text'} or not phone.details or
                                    not text(message['text']) or self.owner(device, active[1]) is not client):
                                raise ProtocolError('invalid proposal')
                            if message['text']:
                                self.proposals[device] = (client, message)
                            else:
                                self.proposals.pop(device, None)
                            if snapshot:
                                if snapshot['failed']:
                                    raise ProtocolError('snapshot unavailable')
                                client.event(event='reply', id=cmd['id'], ok=True, value=None)
                                return
                        elif message['type'] in ('ended', 'error'):
                            self.proposals.pop(device, None)
            await self.enqueue(client, cmd)
            if replay:
                await self.replay_details(*replay)
        except (ValueError, KeyError, TypeError, OSError):
            client.event(event='reply', id=cmd['id'], ok=False)

    async def replay_details(self, device, phone):
        if not phone.details:
            return
        for item in self.inbox(device)['items']:
            request = item['requestId']
            owner = self.owner(device, request)
            message = owner.details.get(device, {}).get(request) if owner else None
            if message:
                await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref, 'message': message})
        proposal = self.proposals.get(device)
        if proposal and self.owner(device, proposal[1]['requestId']) is proposal[0]:
            await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref, 'message': proposal[1]})

    async def event(self, **msg):
        event = msg['event']
        if event == 'reply':
            pending = self.pending.pop(msg['id'], None)
            if pending:
                client, local, op, authority = pending
                if op == 'invalidate' and client is not None:
                    pair = client.retiring.pop(local, None)
                    if msg.get('ok') and pair is not None:
                        client.audience.discard(pair)
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
            self.relay_connected = True
            msg = {**msg, 'routingVersion': 1, 'healthVersion': 1}
        elif event == 'relay':
            self.relay_connected = msg['connected']
            for client in tuple(self.clients):
                if client.health:
                    client.event(event='health', relayConnected=self.relay_connected)
            return
        elif event == 'connected':
            await self.begin_snapshot(msg['deviceId'], msg['ref'])
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
            if message['type'] == 'list':
                await self.begin_snapshot(device, msg['ref'])
            if message['type'] != 'list':
                request = message.get('requestId')
                active = self.active.get(device)
                client = active[0] if message['type'] != 'join' and active and active[1] == request else self.owner(device, request)
                if message['type'] in ('form', 'answer'):
                    key = (device, msg['ref'], request, message['type'])
                    if key in self.touch:
                        return
                    if client is None or len(self.touch) >= MAX_CLIENTS * MAX_PENDING:
                        reply = ({'type': 'form', 'requestId': request, 'form': None} if message['type'] == 'form' else
                                 {'type': 'answer', 'requestId': request, 'status': 'stale', 'message': 'Request unavailable.'})
                        await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': msg['ref'], 'message': reply})
                        return
                    self.touch[key] = client
                if message['type'] == 'join':
                    if client is None:
                        await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': msg['ref'], 'message': {'type': 'error', 'code': 'request-unavailable'}})
                        return
                    # Phone.incoming already excludes simultaneous calls. Retain this
                    # owner through ended -> error; each join creates a new authority.
                    self.active[device] = (client, request)
                    self.proposals.pop(device, None)
                if client in self.clients:
                    client.event(**msg)
                return
        elif event == 'lost':
            snapshot = self.snapshots.pop(msg['deviceId'], None)
            if snapshot:
                snapshot['timer'].cancel()
            self.active.pop(msg['deviceId'], None)
            self.touch = {key: owner for key, owner in self.touch.items() if key[0] != msg['deviceId']}
            self.proposals.pop(msg['deviceId'], None)
            for client in self.clients:
                client.inboxes.pop(msg['deviceId'], None)
                client.details.pop(msg['deviceId'], None)
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
        self.touch = {key: owner for key, owner in self.touch.items() if owner is not client}
        client.writer.close()
        if self.stopping:
            return
        for device, request in client.audience:
            await self.enqueue(None, {'op': 'invalidate', 'deviceId': device, 'requestId': request})
        client.audience.clear()
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
                self.proposals.pop(device, None)
                phone = self.service.phones.get(device)
                if phone and request in (phone.joining, phone.joined):
                    await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref, 'message': {'type': 'ended', 'requestId': request}})
        affected = set(client.inboxes) | {device for device, snapshot in self.snapshots.items() if client in snapshot['waiting']}
        for device in affected:
            snapshot = self.snapshots.get(device)
            if snapshot:
                snapshot['waiting'].discard(client)
                await self.finish_snapshot(device)
                continue
            phone = self.service.phones.get(device)
            if phone:
                await self.enqueue(None, {'op': 'control', 'deviceId': device, 'ref': phone.ref, 'message': self.inbox(device)})
                await self.replay_details(device, phone)
        if not self.clients and not self.stopping:
            self.idle = asyncio.get_running_loop().call_later(10, self.stop)

    def stop(self):
        if not self.clients and self.service and self.service.pending_invalidations:
            self.idle = asyncio.get_running_loop().call_later(30, self.stop)
            return
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
                client.event(event='ready', routingVersion=1, healthVersion=1)
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
                tasks = self.tasks | self.snapshot_tasks
                for task in tuple(tasks):
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
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
