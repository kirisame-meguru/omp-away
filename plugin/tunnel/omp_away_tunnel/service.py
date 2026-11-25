import asyncio
import hashlib
import hmac
import secrets
import time
import sys
from contextlib import AsyncExitStack
from urllib.parse import urlsplit

import aiohttp
from OpenSSL import SSL
from .identity import IdentityStore, ROUTE, digest_bytes
from .ipc import Stdio
from .transport import JSON_LIMIT, ProtocolError, SecureStream, encode, object_json, server_context
from .broker import Broker, proxy
from .controls import inbox_ids, question_display, text


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
        self.ended = None
        self.draining = False
        self.captions = False
        self.marks = set()
        self.details = False
        self.requests = set()
        self.language = None

    def incoming(self, msg):
        """Return false only for validated controls from the most recently ended call."""
        kind, rid = msg.get('type'), msg.get('requestId')
        if kind in ('list', 'join') and 'language' in msg:
            if msg['language'] not in ('en', 'ru'):
                raise ProtocolError('invalid language')
            if kind == 'list':
                self.language = msg['language']
            # Validate the original strict control shape without changing the forwarded frame.
            control = {key: value for key, value in msg.items() if key != 'language'}
        else:
            control = msg
        if kind == 'list' and (fields(control, 'type') or fields(control, 'type', 'details') and type(control['details']) is bool):
            self.details = msg.get('details', False)
            return True
        if not route(rid):
            raise ProtocolError('invalid request')
        if kind == 'form' and fields(msg, 'type', 'requestId'):
            return True
        if kind == 'answer' and (fields(msg, 'type', 'requestId', 'values') or fields(msg, 'type', 'requestId', 'values', 'notes')):
            values = msg['values']
            notes = msg.get('notes', [])
            if not isinstance(notes, list) or len(notes) > 128 or not all(
                    isinstance(note, dict) and fields(note, 'name', 'value', 'text') and
                    all(isinstance(v, str) for v in note.values()) for note in notes):
                raise ProtocolError('invalid option notes')
            if (isinstance(values, dict) and
                    all(isinstance(k, str) and (isinstance(v, str) or type(v) in (int, float) or
                        isinstance(v, list) and all(isinstance(x, str) for x in v)) for k, v in values.items())):
                return True
            raise ProtocolError('invalid answer')
        if kind == 'join' and (fields(control, 'type', 'requestId') or
                               (fields(control, 'type', 'requestId', 'captions') and type(control['captions']) is bool)):
            if self.joined or self.joining:
                raise ProtocolError('call already open')
            # Inbound frames are ordered: a new join fences the previous call's tail.
            self.ended = None
            self.draining = False
            self.marks.clear()
            self.joining = rid
            self.captions = msg.get('captions', False)
            return True
        if kind in ('silence', 'hangup') and fields(msg, 'type', 'requestId'):
            if kind == 'hangup':
                if rid == self.ended:
                    return False
                if rid not in (self.joining, self.joined):
                    raise ProtocolError('wrong call')
            return True
        if kind == 'played' and fields(msg, 'type', 'requestId', 'mark') and rid in (self.joined, self.ended) and marker(msg['mark']) and msg['mark'] in self.marks:
            self.marks.remove(msg['mark'])
            return rid == self.joined
        raise ProtocolError('invalid phone control')

    def incoming_pcm(self):
        if self.joined is not None:
            return True
        # The desktop can end before the handset receives that message. Discard
        # already-sent audio without forwarding it to the old or any future owner.
        if self.draining:
            return False
        raise ProtocolError('audio outside call')

    def outgoing(self, msg):
        try:
            if not isinstance(msg, dict) or len(encode(msg)) > JSON_LIMIT:
                raise ProtocolError('invalid desktop frame')
        except (ValueError, TypeError, UnicodeError):
            raise ProtocolError('invalid desktop frame') from None
        kind, rid = msg.get('type'), msg.get('requestId')
        if kind == 'inbox':
            self.requests = inbox_ids(msg)
            return
        elif kind == 'form' and route(rid) and (
                fields(msg, 'type', 'requestId', 'form') or
                fields(msg, 'type', 'requestId', 'form', 'language') and msg['language'] in ('en', 'ru')):
            if msg['form'] is None or (isinstance(msg['form'], dict) and isinstance(msg['form'].get('sections'), list)):
                return
        elif kind == 'answer' and fields(msg, 'type', 'requestId', 'status', 'message') and route(rid):
            if (msg['status'] in ('accepted', 'invalid', 'stale', 'busy', 'uncertain') and
                    isinstance(msg['message'], str) and len(msg['message']) <= 8192):
                return
        elif kind == 'question' and fields(msg, 'type', 'requestId', 'display'):
            if self.details and route(rid) and rid in self.requests and question_display(msg['display']):
                return
        elif kind == 'proposal' and fields(msg, 'type', 'requestId', 'text'):
            if (self.details and route(rid) and rid in self.requests and text(msg['text']) and
                    (not msg['text'] or rid == self.joined)):
                return
        elif kind == 'error' and fields(msg, 'type', 'code') and route(msg['code']):
            self.joining = None
            return
        elif kind in ('joined', 'ended') and fields(msg, 'type', 'requestId') and route(rid):
            if kind == 'joined' and rid == self.joining and self.joined is None:
                self.joined, self.joining = rid, None
                return
            if kind == 'ended' and rid in (self.joining, self.joined):
                self.ended = rid
                self.draining = self.joined is not None
                self.joined = self.joining = None
                self.captions = False
                return
        elif kind == 'transcript' and fields(msg, 'type', 'requestId', 'role', 'text', 'final'):
            if (self.captions and route(rid) and rid == self.joined and msg['role'] in ('user', 'assistant') and
                    isinstance(msg['text'], str) and 0 < len(msg['text']) <= 8192 and '\0' not in msg['text'] and
                    type(msg['final']) is bool):
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
        self.pending_invalidations = {}  # Bounded opaque routes, retained after their session exits.
        self.invalidation_changed = asyncio.Event()

    async def invalidate(self, device, request):
        pair = (device, request)
        if pair in self.pending_invalidations:
            return
        if len(self.pending_invalidations) >= 4096:
            raise ProtocolError('retirement backlog full')
        self.pending_invalidations[pair] = None
        try:
            await self.post('/v1/invalidations', {'deviceId': device, 'requestId': request}, False)
        except Exception:
            # Acknowledgment means accepted for delivery, not that FCM is authoritative.
            self.pending_invalidations[pair] = time.monotonic() + 1
            self.invalidation_changed.set()
        else:
            self.pending_invalidations.pop(pair, None)

    async def retry_invalidations(self):
        while True:
            now = time.monotonic()
            due = [pair for pair, deadline in self.pending_invalidations.items() if deadline is not None and deadline <= now]
            for device, request in due:
                pair = (device, request)
                self.pending_invalidations[pair] = None
                try:
                    await self.post('/v1/invalidations', {'deviceId': device, 'requestId': request}, False)
                except Exception:
                    self.pending_invalidations[pair] = time.monotonic() + 30
                else:
                    self.pending_invalidations.pop(pair, None)
            deadlines = [deadline for deadline in self.pending_invalidations.values() if deadline is not None]
            delay = max(0, min(deadlines) - time.monotonic()) if deadlines else None
            self.invalidation_changed.clear()
            try:
                async with asyncio.timeout(delay):
                    await self.invalidation_changed.wait()
            except TimeoutError:
                pass

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
                        if phone.incoming_pcm():
                            await self.ipc.media(device, phone.ref, data)
                    else:
                        message = object_json(data)
                        if phone.incoming(message):
                            await self.ipc.event(event='message', deviceId=device, ref=phone.ref, message=message)
        except EOFError:
            pass  # A normal phone/background close still emits 'lost' below.
        except (ValueError, SSL.Error):
            # Malformed framing/JSON/UTF-8 and TLS failures are not routine closes.
            await self.ipc.event(event='error', code='phone_protocol_error')
        except (ConnectionError, TimeoutError, aiohttp.ClientError):
            await self.ipc.event(event='error', code='phone_disconnected')
        except Exception:
            # Never forward raw exception strings, TLS buffers, tokens or application data.
            await self.ipc.event(event='error', code='phone_connection_failed')
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
            await self.ipc.event(event='relay', connected=False)
            await self.ipc.event(event='error', code='relay_disconnected')
            delay = 1
            while True:
                await asyncio.sleep(delay)
                try:
                    socket = await self.connect('/v1/control')
                    await self.ipc.event(event='relay', connected=True)
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
            elif (op in ('ring', 'invalidate') and fields(cmd, 'op', 'id', 'deviceId', 'requestId') and
                  device in self.identity.peers and route(cmd['requestId'])):
                if op == 'invalidate':
                    await self.invalidate(device, cmd['requestId'])
                else:
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
            invalidations = asyncio.create_task(self.retry_invalidations())
            try:
                await self.ipc.event(event='ready')
                while True:
                    cmd = await self.ipc.read()
                    if cmd.get('op') == 'close':
                        break
                    if type(cmd.get('id')) is not int or not 0 < cmd['id'] < 2**32:
                        raise ProtocolError('invalid command id')
                    if cmd['op'] == 'invalidate' and len(self.background) >= 16:
                        await asyncio.wait(self.background, return_when=asyncio.FIRST_COMPLETED)
                    if cmd['op'] in ('pair', 'ring', 'invalidate') and len(self.background) < 16:
                        task = asyncio.create_task(self.execute(cmd))
                        self.background.add(task)
                        task.add_done_callback(self.background.discard)
                    elif cmd['op'] in ('pair', 'ring'):
                        await self.ipc.event(event='reply', id=cmd['id'], ok=False)
                    else:
                        await self.execute(cmd)
            finally:
                control.cancel()
                invalidations.cancel()
                await asyncio.gather(control, invalidations, return_exceptions=True)
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
        if sys.argv[1:] == ['--broker']:
            async with aiohttp.ClientSession(trace_configs=[relay_trace()], trust_env=False, auto_decompress=False,
                                             timeout=aiohttp.ClientTimeout(total=15), cookie_jar=aiohttp.DummyCookieJar()) as http:
                broker = Broker(init)
                await broker.run(Service(init, broker, http))
        elif not sys.argv[1:]:
            await proxy(ipc, init)
        else:
            raise ProtocolError('invalid helper mode')
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
