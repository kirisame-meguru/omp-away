import asyncio
import hashlib
import hmac
import secrets
import time
from contextlib import AsyncExitStack
from urllib.parse import urlsplit

import aiohttp
from .identity import IdentityStore, ROUTE, digest_bytes
from .ipc import Stdio
from .transport import ProtocolError, SecureStream, object_json, server_context


EMOJI = '🐶🐱🦊🐻🐼🐸🐵🐯🦁🐷🐨🐰🐙🐧🐳🐢'


def fingerprint(desktop, phone, nonce):
    digest = hashlib.sha256(b'omp-away/1\0' + digest_bytes(desktop) + digest_bytes(phone) + digest_bytes(nonce)).hexdigest()
    return ''.join(EMOJI[int(n, 16)] for n in digest[:12])


def route(value):
    return isinstance(value, str) and ROUTE.fullmatch(value) is not None


def fields(msg, *names):
    return isinstance(msg, dict) and msg.keys() == set(names)


def marker(value):
    return isinstance(value, str) and 0 < len(value) <= 256


async def read_json(stream):
    kind, data = await stream.read_frame()
    if kind != 1:
        raise ProtocolError('expected pairing control')
    return object_json(data)


class Pairings:
    def __init__(self, identity, confirm):
        self.identity, self.confirm = identity, confirm
        self.offer = None
        self.generation = 0

    def issue(self, url, ticket):
        self.generation += 1
        qr = {'v': 1, 'url': url, 'ticket': ticket, 'desktopPin': self.identity.pin,
              'nonce': secrets.token_urlsafe(32), 'secret': secrets.token_urlsafe(32)}
        self.offer = (time.monotonic() + 600, qr)
        return qr

    def available(self):
        if self.offer is not None and self.offer[0] <= time.monotonic():
            self.offer = None
        return self.offer is not None

    async def enroll(self, stream, device, pin):
        if not self.available() or device in self.identity.peers or pin in self.identity.peers.values():
            raise ProtocolError('enrollment unavailable')
        expires, qr = self.offer
        msg = await read_json(stream)
        if (not fields(msg, 'type', 'nonce', 'secret') or msg['type'] != 'pair' or
                not all(isinstance(msg[k], str) and msg[k].isascii() and hmac.compare_digest(msg[k], qr[k]) for k in ('nonce', 'secret')) or
                self.offer is None or self.offer[1] is not qr or time.monotonic() >= expires):
            raise ProtocolError('enrollment denied')
        self.offer = None  # Claim before any await; no concurrent or subsequent reuse.
        generation = self.generation
        emoji = fingerprint(self.identity.pin, pin, qr['nonce'])
        await stream.send_json({'type': 'verify', 'emoji': emoji})
        async def phone():
            msg = await read_json(stream)
            if not fields(msg, 'type', 'accept') or msg['type'] != 'verify' or msg['accept'] is not True:
                raise ProtocolError('confirmation denied')
        async def desktop():
            if await self.confirm(device, emoji) is not True:
                raise ProtocolError('confirmation denied')
        tasks = [asyncio.create_task(phone()), asyncio.create_task(desktop())]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        if generation != self.generation or time.monotonic() >= expires:
            raise ProtocolError('enrollment expired')
        self.identity.register(device, pin)
        await stream.send_json({'type': 'paired'})


class Phone:
    """Only constructed after TLS authentication and exact route-to-SPKI binding."""
    def __init__(self, stream):
        self.stream = stream
        self.ref = secrets.token_hex(16)  # Local connection epoch, never selected by relay.
        self.joining = self.joined = None
        self.marks = set()

    def incoming(self, msg):
        kind, rid = msg.get('type'), msg.get('requestId')
        if kind == 'list' and fields(msg, 'type'):
            return
        if not route(rid):
            raise ProtocolError('invalid request')
        if kind in ('join', 'silence', 'hangup') and fields(msg, 'type', 'requestId'):
            if kind == 'join':
                if self.joined or self.joining:
                    raise ProtocolError('call already open')
                self.joining = rid
            elif kind == 'hangup' and rid not in (self.joining, self.joined):
                raise ProtocolError('wrong call')
            return
        if kind == 'played' and fields(msg, 'type', 'requestId', 'mark') and rid == self.joined and marker(msg['mark']) and msg['mark'] in self.marks:
            self.marks.remove(msg['mark'])
            return
        raise ProtocolError('invalid phone control')

    def outgoing(self, msg):
        kind, rid = msg.get('type'), msg.get('requestId')
        if kind == 'inbox' and fields(msg, 'type', 'items') and isinstance(msg['items'], list):
            if all(fields(i, 'requestId', 'project', 'question', 'createdAt') and route(i['requestId']) and
                   isinstance(i['project'], str) and isinstance(i['question'], str) and type(i['createdAt']) is int and
                   0 <= i['createdAt'] <= 2**53 - 1 for i in msg['items']):
                return
        elif kind == 'error' and fields(msg, 'type', 'code') and route(msg['code']):
            self.joining = None
            return
        elif kind in ('joined', 'ended') and fields(msg, 'type', 'requestId') and route(rid):
            if kind == 'joined' and rid == self.joining and self.joined is None:
                self.joined, self.joining = rid, None
                return
            if kind == 'ended' and rid in (self.joining, self.joined):
                self.joined = self.joining = None
                self.marks.clear()
                return
        elif kind == 'mark' and fields(msg, 'type', 'requestId', 'mark') and route(rid) and rid == self.joined and marker(msg['mark']):
            if len(self.marks) < 128 and msg['mark'] not in self.marks:
                self.marks.add(msg['mark'])
                return
        raise ProtocolError('invalid desktop control')


class Service:
    def __init__(self, init, ipc, http):
        url = urlsplit(init['url'])
        if (url.scheme != 'https' or not url.hostname or url.username is not None or url.password is not None or
                url.path not in ('', '/') or url.query or url.fragment):
            raise ProtocolError('invalid relay origin')
        self.url = 'https://' + url.netloc
        self.wsurl = 'wss://' + url.netloc
        self.headers = {'Authorization': 'Bearer ' + init['desktopToken']}
        self.identity = IdentityStore(init['stateDir'])
        self.ipc, self.http = ipc, http
        self.pairs = Pairings(self.identity, self.confirm)
        self.waiters = {}
        self.connections = {}
        self.phones = {}
        self.background = set()

    async def confirm(self, device, emoji):
        ref = secrets.token_urlsafe(16)
        waiter = asyncio.get_running_loop().create_future()
        self.waiters[ref] = waiter
        try:
            await self.ipc.event(event='confirm', ref=ref, deviceId=device, emoji=emoji)
            return await waiter
        finally:
            del self.waiters[ref]

    async def connect(self, path):
        return await self.http.ws_connect(self.wsurl + path, headers=self.headers, heartbeat=30,
                                          max_msg_size=131072, compress=0)

    async def post(self, path, body, want_json):
        async with self.http.post(self.url + path, headers=self.headers, json=body, allow_redirects=False) as resp:
            if not want_json:
                if resp.status != 204:
                    raise ProtocolError('invite rejected')
                return
            if resp.status not in (200, 201):
                raise ProtocolError('enrollment rejected')
            data = bytearray()
            async for chunk in resp.content.iter_chunked(1024):
                data.extend(chunk)
                if len(data) > 4096:
                    raise ProtocolError('oversized enrollment response')
            msg = object_json(data)
            if not fields(msg, 'ticket') or not route(msg['ticket']):
                raise ProtocolError('invalid enrollment response')
            return msg['ticket']

    async def tunnel(self, device, connection):
        try:
            async with await self.connect('/v1/tunnels/' + connection) as ws:
                stream = SecureStream(server_context(self.identity), ws, True)
                expected = self.identity.peers.get(device)
                async with asyncio.timeout(15):
                    pin = await stream.handshake(expected)
                if expected is None:
                    async with asyncio.timeout(180):
                        await self.pairs.enroll(stream, device, pin)
                if self.identity.peers.get(device) != pin:
                    raise ProtocolError('unregistered key')
                phone = self.phones[device] = Phone(stream)
                await self.ipc.event(event='connected', deviceId=device, ref=phone.ref)
                while True:
                    kind, data = await stream.read_frame()
                    if kind == 2:
                        if phone.joined is None:
                            raise ProtocolError('audio outside call')
                        await self.ipc.media(device, phone.ref, data)
                    else:
                        message = object_json(data)
                        phone.incoming(message)
                        await self.ipc.event(event='message', deviceId=device, ref=phone.ref, message=message)
        except Exception:
            # Never forward raw exception strings, TLS buffers, tokens or application data.
            await self.ipc.event(event='error', code='phone_disconnected')
        finally:
            removed = self.phones.pop(device, None)
            if removed is not None:
                await self.ipc.event(event='lost', deviceId=device, ref=removed.ref)
            self.connections.pop(device, None)

    async def drop_all(self):
        tasks = list(self.connections.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.connections.clear()

    async def control(self, socket):
        while True:
            try:
                async with socket:
                    async for frame in socket:
                        if frame.type != aiohttp.WSMsgType.TEXT or len(frame.data) > 1024:
                            raise ProtocolError('invalid control notification')
                        msg = object_json(frame.data.encode())
                        if not fields(msg, 'type', 'deviceId', 'connectionId') or msg['type'] != 'connect' or not route(msg['deviceId']) or not route(msg['connectionId']):
                            raise ProtocolError('invalid route notification')
                        device = msg['deviceId']
                        if device not in self.connections and len(self.connections) < 16 and (device in self.identity.peers or self.pairs.available()):
                            self.connections[device] = asyncio.create_task(self.tunnel(device, msg['connectionId']))
            except Exception:
                pass  # Reconnect only to the configured, CA-verified relay.
            await self.drop_all()
            await self.ipc.event(event='error', code='relay_disconnected')
            delay = 1
            while True:
                await asyncio.sleep(delay)
                try:
                    socket = await self.connect('/v1/control')
                    break
                except Exception:
                    delay = min(delay * 2, 30)

    async def execute(self, cmd):
        op, seq = cmd['op'], cmd['id']
        try:
            result = None
            device = cmd.get('deviceId')
            if op == 'devices':
                result = list(self.identity.peers)
            elif op == 'pair':
                ticket = await self.post('/v1/enrollments', {}, True)
                result = self.pairs.issue(self.url, ticket)
            elif op == 'ring' and device in self.identity.peers and route(cmd['requestId']):
                await self.post('/v1/invites', {'deviceId': device, 'requestId': cmd['requestId']}, False)
            elif op == 'confirm' and type(cmd.get('accept')) is bool:
                future = self.waiters.get(cmd['ref'])
                if future is not None and not future.done():
                    future.set_result(cmd['accept'])
            elif op in ('control', 'pcm') and device in self.phones:
                phone = self.phones[device]
                if cmd.get('ref') != phone.ref:
                    raise ProtocolError('stale authenticated tunnel')
                try:
                    async with asyncio.timeout(5):
                        if op == 'control':
                            phone.outgoing(cmd['message'])
                            await phone.stream.send_json(cmd['message'])
                        elif phone.joined is not None and isinstance(cmd['pcm'], bytes):
                            await phone.stream.send_frame(2, cmd['pcm'])
                        else:
                            raise ProtocolError('no joined call')
                except Exception:
                    if self.phones.get(device) is phone:
                        self.connections[device].cancel()
                    raise
            else:
                raise ProtocolError('operation denied')
            await self.ipc.event(event='reply', id=seq, ok=True, value=result)
        except Exception:
            await self.ipc.event(event='reply', id=seq, ok=False)

    async def run(self):
        async with AsyncExitStack() as stack:
            ws = await self.connect('/v1/control')
            stack.push_async_callback(ws.close)
            control = asyncio.create_task(self.control(ws))
            try:
                await self.ipc.event(event='ready')
                while True:
                    cmd = await self.ipc.read()
                    if cmd.get('op') == 'close':
                        break
                    if type(cmd.get('id')) is not int or not 0 < cmd['id'] < 2**32:
                        raise ProtocolError('invalid command id')
                    if cmd['op'] in ('pair', 'ring') and len(self.background) < 16:
                        task = asyncio.create_task(self.execute(cmd))
                        self.background.add(task)
                        task.add_done_callback(self.background.discard)
                    elif cmd['op'] in ('pair', 'ring'):
                        await self.ipc.event(event='reply', id=cmd['id'], ok=False)
                    else:
                        await self.execute(cmd)
            finally:
                control.cancel()
                await asyncio.gather(control, return_exceptions=True)
                await self.drop_all()
                tasks = list(self.background)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)


def relay_trace():
    trace = aiohttp.TraceConfig()

    async def reject_redirect(*unused):
        raise ProtocolError('relay redirect denied')

    # The WebSocket handshake uses HTTP redirect machinery. Abort before a
    # second authenticated request can be dispatched, even on the same origin.
    trace.on_request_redirect.append(reject_redirect)
    return trace


async def run():
    ipc = Stdio()
    try:
        init = await ipc.read()
        if not fields(init, 'op', 'url', 'desktopToken', 'stateDir') or init['op'] != 'start':
            raise ProtocolError('invalid startup')
        async with aiohttp.ClientSession(trace_configs=[relay_trace()], trust_env=False, auto_decompress=False,
                                         timeout=aiohttp.ClientTimeout(total=15), cookie_jar=aiohttp.DummyCookieJar()) as http:
            await Service(init, ipc, http).run()
    except EOFError:
        pass
    except PermissionError:
        await ipc.event(event='fatal', code='state_permissions_denied')
    except aiohttp.ClientError:
        await ipc.event(event='fatal', code='relay_connection_failed')
    except Exception:
        await ipc.event(event='fatal', code='secure_helper_failed')


def main():
    asyncio.run(run())
