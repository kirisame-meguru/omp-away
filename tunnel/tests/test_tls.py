import asyncio
import tempfile
import unittest
from pathlib import Path

from OpenSSL import SSL, crypto
from cryptography.hazmat.primitives import serialization
from omp_away_tunnel.identity import IdentityStore
from omp_away_tunnel.transport import SecureStream, server_context, ProtocolError


class Pipe:
    def __init__(self):
        self.inbox = asyncio.Queue()
        self.capture = bytearray()
        self.tamper = False

    async def receive_bytes(self):
        return await self.inbox.get()

    async def send_bytes(self, data):
        self.capture.extend(data)
        if self.tamper:
            data = data[:-1] + bytes([data[-1] ^ 1])
        await self.other.inbox.put(data)


class TunnelTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.desktop, self.phone, self.impostor = [IdentityStore(Path(self.temp.name) / name) for name in ('desktop', 'phone', 'other')]

    def endpoints(self, phone_identity, expected_desktop=None, send_cert=True):
        left, right = Pipe(), Pipe()
        left.other, right.other = right, left
        server = SecureStream(server_context(self.desktop), left, True)
        # Use a genuine TLS client: validate the exact desktop certificate with OpenSSL.
        ctx = SSL.Context(SSL.TLS_CLIENT_METHOD)
        ctx.set_min_proto_version(SSL.TLS1_3_VERSION)
        ctx.get_cert_store().add_cert(crypto.X509.from_cryptography((expected_desktop or self.desktop).cert))
        ctx.set_verify(SSL.VERIFY_PEER, lambda conn, cert, err, depth, ok: ok)
        if send_cert:
            ctx.use_certificate(phone_identity.cert)
            ctx.use_privatekey(phone_identity.key)
        return server, SecureStream(ctx, right, False), left, right

    async def handshake(self, server, client, pin):
        tasks = [asyncio.create_task(server.handshake(pin)), asyncio.create_task(client.handshake(None))]
        try:
            return await asyncio.wait_for(asyncio.gather(*tasks), 3)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def test_pinned_mutual_tls_hides_sentinel_and_detects_tampered_record(self):
        server, client, a, b = self.endpoints(self.phone)
        self.assertEqual(await self.handshake(server, client, self.phone.pin), [self.phone.pin, self.desktop.pin])
        sentinel = b'private-inbox-sentinel-3f5ec70ed8f9'
        await server.send_frame(1, sentinel)
        self.assertEqual(await client.read_frame(), (1, sentinel))
        self.assertNotIn(sentinel, a.capture + b.capture)
        b.tamper = True
        await client.send_frame(1, sentinel)
        with self.assertRaises((SSL.Error, ProtocolError)):
            await server.read_frame()

    async def test_stolen_route_does_not_authorize_changed_phone_key(self):
        server, client, _, _ = self.endpoints(self.impostor)
        with self.assertRaises(ProtocolError):
            await self.handshake(server, client, self.phone.pin)

    async def test_substituted_desktop_and_missing_client_certificate_rejected(self):
        for wrong_desktop, send_cert in [(self.impostor, True), (None, False)]:
            server, client, _, _ = self.endpoints(self.phone, wrong_desktop, send_cert)
            with self.assertRaises(SSL.Error):
                await self.handshake(server, client, self.phone.pin)

    def test_pairing_pin_survives_restart_and_cannot_be_rebound(self):
        self.desktop.register('phone-1', self.phone.pin)
        other = IdentityStore(self.desktop.directory)
        self.assertEqual(other.pin, self.desktop.pin)
        self.assertEqual(other.peers['phone-1'], self.phone.pin)
        with self.assertRaises(ValueError):
            other.register('phone-1', self.impostor.pin)
        with self.assertRaises(ValueError):
            other.register('phone-2', self.phone.pin)
        self.assertEqual(other.cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo), self.desktop.cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))
