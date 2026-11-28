import unittest
import copy

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


class QuestionControlTest(unittest.TestCase):
    item = dict(requestId='request-A', project='Example', question='Pick one', createdAt=1, session='Release review')
    display = dict(v=1, context='Context', fields=[
        dict(id='f1', label='Pick one', kind='single', required=True, other=True, description='Group',
             options=[dict(id='o1', label='Same', disabled=False), dict(id='o2', label='Same', disabled=True)]),
        dict(id='f2', label='Notes', kind='text', required=False, inputType='textarea', placeholder='Optional')])

    def phone(self):
        phone = Phone(None)
        phone.incoming(dict(type='list', details=True))
        phone.outgoing(dict(type='inbox', items=[self.item]))
        return phone

    def test_metadata_requires_negotiation_and_current_inbox_membership(self):
        message = dict(type='question', requestId='request-A', display=self.display)
        phone = Phone(None)
        phone.outgoing(dict(type='inbox', items=[self.item]))
        with self.assertRaises(ProtocolError):
            phone.outgoing(message)
        phone.incoming(dict(type='list', details=True))
        phone.outgoing(message)
        phone.outgoing(dict(type='proposal', requestId='request-A', text=''))
        with self.assertRaises(ProtocolError):
            phone.outgoing(dict(type='proposal', requestId='request-A', text='Same'))
        phone.incoming(dict(type='join', requestId='request-A'))
        phone.outgoing(dict(type='joined', requestId='request-A'))
        phone.outgoing(dict(type='proposal', requestId='request-A', text='Pick one: Same'))
        phone.outgoing(dict(type='inbox', items=[]))
        with self.assertRaises(ProtocolError):
            phone.outgoing(message)
        phone.incoming(dict(type='list'))
        self.assertFalse(phone.details)

    def test_old_inboxes_and_empty_details_are_safe(self):
        phone = Phone(None)
        phone.outgoing(dict(type='inbox', items=[{k: v for k, v in self.item.items() if k != 'session'}]))
        for value in ['true', 1, None, []]:
            with self.assertRaises(ProtocolError):
                phone.incoming(dict(type='list', details=value))

    def test_malformed_oversized_or_secret_fields_are_rejected(self):
        phone = self.phone()
        mutations = [
            lambda d: d.update(v=2), lambda d: d.update(v=True),
            lambda d: d.update(context='\ud800'),
            lambda d: d.update(context='x' * 8193),
            lambda d: d.update(fields=d['fields'] * 17),
            lambda d: d['fields'][0].update(value='capability'),
            lambda d: d['fields'][0].update(required=1),
            lambda d: d['fields'][0]['options'][0].update(value='secret'),
            lambda d: d['fields'][0]['options'][0].update(disabled='false'),
            lambda d: d['fields'][0]['options'][1].update(id='o1'),
            lambda d: d['fields'][0].update(options=[dict(id=f'o{i}', label='X', disabled=False) for i in range(257)]),
            lambda d: d['fields'][0].update(description='界' * 8192, label='界' * 8192),
        ]
        for mutate in mutations:
            display = copy.deepcopy(self.display)
            mutate(display)
            with self.assertRaises(ProtocolError):
                phone.outgoing(dict(type='question', requestId='request-A', display=display))
        with self.assertRaises(ProtocolError):
            phone.outgoing(dict(type='question', requestId='other', display=self.display))
        for session in ['x' * 129, 1, 'bad\0name']:
            with self.assertRaises(ProtocolError):
                phone.outgoing(dict(type='inbox', items=[self.item | dict(session=session)]))
        phone.outgoing(dict(type='inbox', items=[self.item | dict(call='5b8f0c62-1f4e-4d1c-9a58-0f1d7b7e8a01')]))
        for call in ['', 'x' * 129, 1, 'bad token']:
            with self.assertRaises(ProtocolError):
                phone.outgoing(dict(type='inbox', items=[self.item | dict(call=call)]))
        with self.assertRaises(ProtocolError):
            phone.outgoing(dict(type='inbox', items=[self.item | dict(requestId=f'r{i}', question='x' * 256) for i in range(400)]))


if __name__ == '__main__':
    unittest.main()
