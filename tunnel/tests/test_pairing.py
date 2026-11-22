import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from secrets import token_urlsafe
from omp_away_tunnel.identity import IdentityStore, b64
from omp_away_tunnel.service import Pairings, fingerprint
from omp_away_tunnel.transport import ProtocolError


class Endpoint:
    def __init__(self, data):
        self.data = asyncio.Queue()
        self.sent = []
        for value in data:
            self.data.put_nowait((1, json.dumps(value).encode()))

    async def read_frame(self):
        return await self.data.get()

    async def send_json(self, msg):
        self.sent.append(msg)


class PairingTest(unittest.IsolatedAsyncioTestCase):
    def test_role_ordered_handset_vector(self):
        desktop, phone, nonce = [b64(bytes(range(start, start + 32))) for start in (0, 32, 64)]
        self.assertEqual(fingerprint(desktop, phone, nonce), '🐷🐶🦁🐶🐰🐢🦁🐳🐙🐷🐻🐸')
        self.assertNotEqual(fingerprint(phone, desktop, nonce), fingerprint(desktop, phone, nonce))

    async def test_matching_secret_and_both_confirmations_required(self):
        with tempfile.TemporaryDirectory() as d:
            identity = IdentityStore(Path(d) / 'state')
            for n, (phone_ok, desktop_ok, bad_secret) in enumerate([(False, True, False), (True, False, False), (True, True, True), (True, True, False)]):
                seen = []
                async def confirm(device, emoji):
                    seen.append(emoji)
                    return desktop_ok
                pairs = Pairings(identity, confirm)
                qr = pairs.issue('https://away.example.invalid', token_urlsafe(32))
                pin, device = token_urlsafe(32), f'phone-{n}'
                stream = Endpoint([{'type':'pair','nonce':qr['nonce'],'secret':token_urlsafe(32) if bad_secret else qr['secret']}, {'type':'verify','accept':phone_ok}])
                if not phone_ok or not desktop_ok or bad_secret:
                    with self.assertRaises(ProtocolError):
                        await pairs.enroll(stream, device, pin)
                    self.assertNotIn(device, identity.peers)
                    self.assertNotIn({'type':'paired'}, stream.sent)
                    if bad_secret:
                        self.assertEqual(stream.sent, [])
                else:
                    await pairs.enroll(stream, device, pin)
                    self.assertEqual(stream.sent, [{'type':'verify','emoji':seen[0]}, {'type':'paired'}])
                    self.assertEqual(len(seen[0]), 12)
                    self.assertEqual(identity.peers[device], pin)
                    with self.assertRaises(ProtocolError):
                        await pairs.enroll(Endpoint([]), 'new-device', token_urlsafe(32))
