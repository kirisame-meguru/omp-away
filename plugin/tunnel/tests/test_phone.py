import unittest

from omp_away_tunnel.service import Phone
from omp_away_tunnel.transport import ProtocolError


class PhoneTest(unittest.TestCase):
    def joined(self):
        phone = Phone(None)
        phone.incoming({'type': 'join', 'requestId': 'request_a'})
        phone.outgoing({'type': 'joined', 'requestId': 'request_a'})
        return phone

    def test_ended_call_discards_inflight_audio_and_hangup(self):
        phone = self.joined()
        self.assertTrue(phone.incoming_pcm())
        phone.outgoing({'type': 'ended', 'requestId': 'request_a'})
        self.assertFalse(phone.incoming_pcm())
        self.assertFalse(phone.incoming({'type': 'hangup', 'requestId': 'request_a'}))
        self.assertTrue(phone.incoming({'type': 'list'}))

    def test_ended_call_accepts_only_its_outstanding_playback_marks_once(self):
        phone = self.joined()
        phone.outgoing({'type': 'mark', 'requestId': 'request_a', 'mark': 'known'})
        phone.outgoing({'type': 'ended', 'requestId': 'request_a'})
        self.assertFalse(phone.incoming({'type': 'played', 'requestId': 'request_a', 'mark': 'known'}))
        for request, mark in [('request_a', 'known'), ('request_a', 'unknown'), ('request_b', 'known')]:
            with self.subTest(request=request, mark=mark), self.assertRaises(ProtocolError):
                phone.incoming({'type': 'played', 'requestId': request, 'mark': mark})

    def test_idle_and_setup_audio_remain_invalid(self):
        phone = Phone(None)
        with self.assertRaises(ProtocolError):
            phone.incoming_pcm()
        phone.incoming({'type': 'join', 'requestId': 'request_a'})
        with self.assertRaises(ProtocolError):
            phone.incoming_pcm()
        phone.outgoing({'type': 'ended', 'requestId': 'request_a'})
        with self.assertRaises(ProtocolError):
            phone.incoming_pcm()

    def test_next_ordered_join_fences_old_audio_and_controls(self):
        phone = self.joined()
        phone.outgoing({'type': 'mark', 'requestId': 'request_a', 'mark': 'old'})
        phone.outgoing({'type': 'ended', 'requestId': 'request_a'})
        self.assertTrue(phone.incoming({'type': 'join', 'requestId': 'request_b'}))
        with self.assertRaises(ProtocolError):
            phone.incoming_pcm()
        for message in [
            {'type': 'hangup', 'requestId': 'request_a'},
            {'type': 'played', 'requestId': 'request_a', 'mark': 'old'},
            {'type': 'played', 'requestId': 'request_b', 'mark': 'old'},
        ]:
            with self.subTest(message=message), self.assertRaises(ProtocolError):
                phone.incoming(message)
        phone.outgoing({'type': 'joined', 'requestId': 'request_b'})
        self.assertTrue(phone.incoming_pcm())
        self.assertTrue(phone.incoming({'type': 'hangup', 'requestId': 'request_b'}))

    def test_teardown_does_not_relax_message_validation(self):
        phone = self.joined()
        phone.outgoing({'type': 'ended', 'requestId': 'request_a'})
        for message in [
            {'type': 'hangup', 'requestId': 'request_b'},
            {'type': 'hangup', 'requestId': 'request_a', 'extra': True},
            {'type': 'unknown', 'requestId': 'request_a'},
            {'type': 'played', 'requestId': 'request_a', 'mark': 'unknown'},
        ]:
            with self.subTest(message=message), self.assertRaises(ProtocolError):
                phone.incoming(message)
