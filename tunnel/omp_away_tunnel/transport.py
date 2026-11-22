import asyncio
import hmac
import json
import struct

from OpenSSL import SSL
from .identity import pin_of


class ProtocolError(ValueError):
    pass


HEADER = struct.Struct('!BI')
JSON_LIMIT = 65536
PCM_SIZE = 960


def check_frame(kind, size):
    if not ((kind == 1 and 0 < size <= JSON_LIMIT) or (kind == 2 and size == PCM_SIZE)):
        raise ProtocolError('invalid inner frame')


def object_json(data):
    def unique(pairs):
        obj = dict(pairs)
        if len(obj) != len(pairs):
            raise ProtocolError('duplicate fields')
        return obj
    msg = json.loads(data.decode('utf-8'), object_pairs_hook=unique)
    if not isinstance(msg, dict):
        raise ProtocolError('expected object')
    return msg


def encode(msg):
    return json.dumps(msg, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


def server_context(identity):
    # Per-connection context: a new handshake and CertificateVerify on EVERY tunnel.
    ctx = SSL.Context(SSL.TLS_SERVER_METHOD)
    ctx.set_min_proto_version(SSL.TLS1_3_VERSION)
    ctx.set_max_proto_version(SSL.TLS1_3_VERSION)
    ctx.set_options(SSL.OP_NO_TICKET)
    ctx.set_session_cache_mode(SSL.SESS_CACHE_OFF)
    ctx.use_certificate(identity.cert)
    ctx.use_privatekey(identity.key)
    ctx.check_privatekey()
    # Only the untrusted self-signed leaf error is waived for this inner TLS context.
    # OpenSSL still verifies certificate validity and the transcript signature (not
    # controlled by this chain callback). Never install this callback on outer TLS.
    ctx.set_verify(SSL.VERIFY_PEER | SSL.VERIFY_FAIL_IF_NO_PEER_CERT,
                   lambda conn, cert, err, depth, ok: depth == 0 and (ok or err == 18))
    return ctx


class SecureStream:
    def __init__(self, context, socket, server):
        self.conn = SSL.Connection(context, None)
        if server:
            self.conn.set_accept_state()
        else:
            self.conn.set_connect_state()
        self.ws = socket
        self.flush_lock = asyncio.Lock()
        self.send_lock = asyncio.Lock()
        self.ready = False

    async def _flush(self):
        async with self.flush_lock:
            while True:
                try:
                    block = self.conn.bio_read(16384)
                except SSL.WantReadError:
                    return
                await self.ws.send_bytes(block)

    async def _receive(self):
        await self._flush()
        block = await self.ws.receive_bytes()
        if not block or len(block) > 131072:
            raise ProtocolError('invalid TLS fragment')
        self.conn.bio_write(block)

    async def handshake(self, expected_pin):
        while True:
            try:
                self.conn.do_handshake()
                break
            except SSL.WantReadError:
                await self._receive()
            except SSL.WantWriteError:
                await self._flush()
        cert = self.conn.get_peer_certificate(as_cryptography=True)
        if self.conn.get_protocol_version_name() != 'TLSv1.3' or cert is None:
            raise ProtocolError('peer authentication failed')
        pin = pin_of(cert)
        if expected_pin is not None and not hmac.compare_digest(expected_pin, pin):
            raise ProtocolError('peer key changed')
        await self._flush()
        self.ready = True
        return pin

    async def _read_exact(self, size):
        parts = bytearray()
        while len(parts) < size:
            try:
                part = self.conn.recv(size - len(parts))
            except SSL.WantReadError:
                await self._receive()
                continue
            except SSL.WantWriteError:
                await self._flush()
                continue
            if not part:
                raise EOFError
            parts.extend(part)
        return bytes(parts)

    async def read_frame(self):
        if not self.ready:
            raise ProtocolError('handshake required')
        kind, size = HEADER.unpack(await self._read_exact(HEADER.size))
        check_frame(kind, size)
        return kind, await self._read_exact(size)

    async def send_frame(self, kind, data):
        if not self.ready:
            raise ProtocolError('handshake required')
        check_frame(kind, len(data))
        async with self.send_lock:
            payload = HEADER.pack(kind, len(data)) + data
            pos = 0
            while pos < len(payload):
                pos += self.conn.send(payload[pos:])
            await self._flush()

    async def send_json(self, msg):
        await self.send_frame(1, encode(msg))
