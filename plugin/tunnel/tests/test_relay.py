"""Use genuine HTTPS/WSS, a disposable local trust anchor and two inner TLS peers."""
import asyncio
import ipaddress
import json
import secrets
import socket
import ssl
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from OpenSSL import SSL, crypto
from omp_away_tunnel.identity import IdentityStore, private_directory
from omp_away_tunnel.service import Service, relay_trace
from omp_away_tunnel.transport import ProtocolError, SecureStream


def outer_tls(path):
    private_directory(path)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Temporary loopback endpoint')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(hours=1)).not_valid_after(now + timedelta(hours=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), False)
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False).sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    (path / 'cert').write_text(pem)
    (path / 'key').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(path / 'cert', path / 'key')
    return server, ssl.create_default_context(cadata=pem)


async def close_tls_server(server):
    """Drain this fixture's accepts and TLS transports, not just aiohttp handlers."""
    if not server.started or server.closed:
        return
    listeners = [site._server for site in server.runner.sites if site._server is not None]
    async with asyncio.timeout(5):
        for listener in listeners:
            loop = listener.get_loop()
            accepts = getattr(loop, '_accept_futures', None)
            if accepts is None:
                continue
            descriptors = [sock.fileno() for sock in listener.sockets]
            # CPython Proactor Server.close() clears _sockets before a completed
            # accept's queued callback can attach its SSL transport. Drain only
            # our listeners' callbacks while their Server is still attachable.
            # A completed accept may install the next one: cancel/drain that too.
            while True:
                pending = [future for fd in descriptors if (future := accepts.pop(fd, None)) is not None]
                if not pending:
                    break
                for future in pending:
                    future.cancel()
                results = await asyncio.gather(*pending, return_exceptions=True)
                for result in results:
                    if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                        raise result
        # Python 3.11 Server.wait_closed() returns immediately once _sockets
        # is None, even if accepted transports still contribute to _active_count.
        # Register its drain waiters before aiohttp closes the listeners.
        drains = [asyncio.create_task(listener.wait_closed()) for listener in listeners]
        try:
            await asyncio.sleep(0)
            await server.close()
            # HTTP handler shutdown cannot see unfinished TLS handshakes.
            await asyncio.gather(*drains)
        finally:
            for drain in drains:
                drain.cancel()
            await asyncio.gather(*drains, return_exceptions=True)


class LocalHost:
    def __init__(self):
        self.commands, self.events = asyncio.Queue(), asyncio.Queue()

    async def read(self):
        return await self.commands.get()

    async def event(self, **msg):
        await self.events.put(msg)

    async def media(self, device, ref, pcm):
        await self.event(event='pcm', deviceId=device, ref=ref, pcm=pcm)

    async def expect(self, event):
        msg = await asyncio.wait_for(self.events.get(), 4)
        if msg['event'] != event:
            raise AssertionError(f"expected {event}, got {msg['event']}")
        return msg

    async def command(self, op, **args):
        await self.commands.put({'op':op, 'id':1, **args})
        return await self.expect('reply')


class RelayTest(unittest.IsolatedAsyncioTestCase):
    def make_ipc(self, init):
        return LocalHost()

    async def run_service(self):
        await self.service.run()

    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        server_tls, trust = outer_tls(self.root / 'test-certificate')
        self.control_ready = asyncio.Queue()
        self.desktop_ready = asyncio.Queue()
        self.capture = bytearray()
        self.invites = []
        self.invalidations = []
        self.fail_invalidations = 0
        self.desktop_token = secrets.token_urlsafe(32)
        self.finish = asyncio.Event()
        self.handles = []
        self.redirected = False

        async def handle(req):
            if req.headers.get('Authorization') != 'Bearer ' + self.desktop_token or req.query:
                raise web.HTTPForbidden()
            if req.path == '/v1/enrollments':
                self.assertEqual(await req.json(), {})
                return web.json_response({'ticket':secrets.token_urlsafe(32)})
            if req.path == '/v1/invites':
                self.invites.append(await req.json())
                return web.Response(status=204)
            if req.path == '/v1/invalidations':
                if self.fail_invalidations:
                    self.fail_invalidations -= 1
                    return web.Response(status=503)
                self.invalidations.append(await req.json())
                return web.Response(status=204)
            if req.path == '/redirect':
                raise web.HTTPTemporaryRedirect('/wrong')
            if req.path == '/wrong':
                self.redirected = True
                raise web.HTTPNotFound()
            ws = web.WebSocketResponse(compress=False)
            await ws.prepare(req)
            self.handles.append(ws)
            if req.path == '/v1/control':
                await self.control_ready.put(ws)
            elif req.path == '/v1/tunnels/connection_1':
                await self.desktop_ready.put(ws)
            else:
                raise web.HTTPNotFound()
            await self.finish.wait()
            return ws

        app = web.Application()
        app.router.add_route('*', '/{path:.*}', handle)
        self.server = TestServer(app, scheme='https', host='127.0.0.1')
        await self.server.start_server(ssl=server_tls, access_log=None)
        self.client = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=trust), trace_configs=[relay_trace()])
        init = {'op': 'start', 'url': str(self.server.make_url('/')), 'desktopToken': self.desktop_token, 'stateDir': str(self.root / 'desktop')}
        self.host = self.make_ipc(init)
        self.service = Service(init, self.host, self.client)
        self.worker = asyncio.create_task(self.run_service())
        await self.host.expect('ready')

    async def asyncTearDown(self):
        self.finish.set()
        self.worker.cancel()
        await asyncio.gather(self.worker, return_exceptions=True)
        await self.client.close()
        await asyncio.gather(*(ws.close() for ws in self.handles if not ws.closed))
        await close_tls_server(self.server)

    async def test_wss_redirect_is_not_followed(self):
        with self.assertRaises(ProtocolError):
            await self.service.connect('/redirect')
        self.assertFalse(self.redirected)

    async def test_invalid_tunnel_frame_remains_a_protocol_error_not_a_routine_disconnect(self):
        phone = IdentityStore(self.root / 'phone')
        self.service.identity.register('phone_1', phone.pin)
        control = await self.control_ready.get()
        await control.send_json({'type':'connect','deviceId':'phone_1','connectionId':'connection_1'})
        ws = await asyncio.wait_for(self.desktop_ready.get(), 4)
        await ws.send_str('not a binary TLS frame')
        await ws.close()
        self.assertEqual(await self.host.expect('error'), {'event':'error', 'code':'phone_protocol_error'})
        self.assertFalse(self.service.phones)

    async def test_private_inbox_only_after_proved_route_and_both_confirmations(self):
        unknown = await self.host.command('ring', deviceId='phone_1', requestId='request_1')
        self.assertFalse(unknown['ok'])
        self.assertFalse(self.invites)
        qr = (await self.host.command('pair'))['value']
        control = await self.control_ready.get()
        await control.send_json({'type':'connect','deviceId':'phone_1','connectionId':'connection_1'})
        ws = await asyncio.wait_for(self.desktop_ready.get(), 4)
        capture = self.capture
        class RelayView:
            async def send_bytes(self, block):
                capture.extend(block)
                await ws.send_bytes(block)
            async def receive(self):
                message = await ws.receive(timeout=4)
                if message.type == aiohttp.WSMsgType.BINARY:
                    capture.extend(message.data)
                return message
        phone_key = IdentityStore(self.root / 'phone')
        ctx = SSL.Context(SSL.TLS_CLIENT_METHOD)
        ctx.set_min_proto_version(SSL.TLS1_3_VERSION)
        ctx.get_cert_store().add_cert(crypto.X509.from_cryptography(self.service.identity.cert))
        ctx.set_verify(SSL.VERIFY_PEER, lambda conn, cert, err, depth, ok: ok)
        ctx.use_certificate(phone_key.cert)
        ctx.use_privatekey(phone_key.key)
        phone = SecureStream(ctx, RelayView(), False)
        self.assertEqual(await phone.handshake(qr['desktopPin']), qr['desktopPin'])
        await phone.send_json({'type':'pair', 'nonce':qr['nonce'], 'secret':qr['secret']})
        _, verify = await phone.read_frame()
        prompt = await self.host.expect('confirm')
        self.assertEqual(json.loads(verify), {'type':'verify', 'emoji':prompt['emoji']})
        await phone.send_json({'type':'verify','accept':True})
        self.assertEqual((await self.host.command('devices'))['value'], [])
        await self.host.command('confirm', ref=prompt['ref'], accept=True)
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type':'paired'})
        connected = await self.host.expect('connected')
        self.assertEqual(connected['deviceId'], 'phone_1')
        await phone.send_json({'type':'list'})
        self.assertEqual((await self.host.expect('message'))['message'], {'type':'list'})
        sentinel = 'secret-question-' + secrets.token_hex(16)
        msg = {'type':'inbox','items':[{'requestId':'request_1','project':'private','question':sentinel,'createdAt':123}]}
        self.assertFalse((await self.host.command('control', deviceId='phone_1', ref='0'*32, message=msg))['ok'])
        self.assertTrue((await self.host.command('control', deviceId='phone_1', ref=connected['ref'], message=msg))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), msg)
        self.assertTrue((await self.host.command('ring', deviceId='phone_1', requestId='request_1'))['ok'])
        self.assertEqual(self.invites, [{'deviceId':'phone_1','requestId':'request_1'}])
        join = {'type':'join', 'requestId':'request_1'}
        joined = {'type':'joined', 'requestId':'request_1'}
        await phone.send_json(join)
        self.assertEqual((await self.host.expect('message'))['message'], join)
        dest = {'deviceId':'phone_1', 'ref':connected['ref']}
        self.assertTrue((await self.host.command('control', **dest, message=joined))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), joined)
        pcm = secrets.token_bytes(960)
        await phone.send_frame(2, pcm)
        self.assertEqual(await self.host.expect('pcm'), {'event':'pcm', **dest, 'pcm':pcm})
        self.assertFalse((await self.host.command('pcm', deviceId='phone_1', ref='0'*32, pcm=pcm))['ok'])
        self.assertTrue((await self.host.command('pcm', **dest, pcm=pcm))['ok'])
        self.assertEqual(await phone.read_frame(), (2, pcm))
        self.assertNotIn(pcm[:32], capture)
        await ws.close()
        self.assertEqual(await self.host.expect('lost'), {'event':'lost', **dest})
        for secret in (sentinel, qr['secret'], qr['nonce'], prompt['emoji']):
            self.assertNotIn(secret.encode(), capture)


class TLSFixtureTest(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_drains_accepted_sockets_and_unfinished_tls_handshakes(self):
        with tempfile.TemporaryDirectory() as directory:
            tls, _ = outer_tls(Path(directory) / 'certificate')
            loop = asyncio.get_running_loop()
            errors = []
            previous = loop.get_exception_handler()
            def report(loop, context):
                errors.append(context)
                if previous is None:
                    loop.default_exception_handler(context)
                else:
                    previous(loop, context)
            loop.set_exception_handler(report)
            try:
                for phase in ('accepted', 'handshake'):
                    with self.subTest(phase=phase):
                        server = TestServer(web.Application(), scheme='https', host='127.0.0.1')
                        await server.start_server(ssl=tls, access_log=None)
                        listener = next(iter(server.runner.sites))._server
                        descriptors = [sock.fileno() for sock in listener.sockets]
                        peer = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        peer.setblocking(False)
                        closing = None
                        try:
                            await loop.sock_connect(peer, ('127.0.0.1', server.port))
                            if phase == 'handshake':
                                async with asyncio.timeout(2):
                                    while listener._active_count == 0:
                                        await asyncio.sleep(0)
                                closing = asyncio.create_task(close_tls_server(server))
                                async with asyncio.timeout(2):
                                    while listener.is_serving():
                                        await asyncio.sleep(0)
                                done, _ = await asyncio.wait({closing}, timeout=.02)
                                if done:
                                    await closing
                                    self.assertEqual(listener._active_count, 0,
                                                     'Cleanup returned while its accepted TLS socket was still live')
                            peer.close()
                            if closing is None:
                                closing = asyncio.create_task(close_tls_server(server))
                            await closing
                            self.assertEqual(listener._active_count, 0)
                            self.assertFalse(listener.is_serving())
                            self.assertEqual(listener.sockets, ())
                            accepts = getattr(loop, '_accept_futures', {})
                            self.assertTrue(all(fd not in accepts for fd in descriptors))
                        finally:
                            peer.close()
                            if closing is not None and not closing.done():
                                await closing
                            await close_tls_server(server)
                self.assertEqual(errors, [])
            finally:
                loop.set_exception_handler(previous)
