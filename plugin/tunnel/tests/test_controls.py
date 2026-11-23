import unittest

from omp_away_tunnel.service import Phone
from omp_away_tunnel.transport import ProtocolError


class CaptionControlTest(unittest.TestCase):
    def caption(self, **changes):
        return dict(type='transcript', requestId='call-A', role='user', text='Coffee', final=False) | changes

    def test_captions_require_opt_in_and_a_joined_current_call(self):
        phone = Phone(None)
        phone.incoming({'type': 'join', 'requestId': 'call-A', 'captions': True})
        with self.assertRaises(ProtocolError):
            phone.outgoing(self.caption())
        phone.outgoing({'type': 'joined', 'requestId': 'call-A'})
        self.assertIsNone(phone.outgoing(self.caption()))
        with self.assertRaises(ProtocolError):
            phone.outgoing(self.caption(requestId='other-call'))
        phone.outgoing({'type': 'ended', 'requestId': 'call-A'})
        with self.assertRaises(ProtocolError):
            phone.outgoing(self.caption())
        phone.incoming({'type': 'join', 'requestId': 'call-B'})
        phone.outgoing({'type': 'joined', 'requestId': 'call-B'})
        with self.assertRaises(ProtocolError):
            phone.outgoing(self.caption(requestId='call-B'))

    def test_invalid_caption_content_cannot_cross_the_tunnel(self):
        phone = Phone(None)
        phone.incoming({'type': 'join', 'requestId': 'call-A', 'captions': True})
        phone.outgoing({'type': 'joined', 'requestId': 'call-A'})
        for changes in [dict(role='system'), dict(text=''), dict(text='x' * 8193),
                        dict(text='a\0b'), dict(final='true'), dict(final=1), dict(extra='data')]:
            with self.subTest(changes=list(changes)):
                with self.assertRaises(ProtocolError):
                    phone.outgoing(self.caption(**changes))
        self.assertIsNone(phone.outgoing(self.caption(role='assistant', text='x' * 8192, final=True)))

    def test_caption_opt_in_does_not_coerce_non_boolean_values(self):
        for value in ['true', 1, None, []]:
            with self.subTest(kind=type(value).__name__):
                phone = Phone(None)
                with self.assertRaises(ProtocolError):
                    phone.incoming({'type': 'join', 'requestId': 'call-A', 'captions': value})


if __name__ == '__main__':
    unittest.main()
