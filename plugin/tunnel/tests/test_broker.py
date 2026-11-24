import asyncio
import json
import os
import secrets
import shutil
import signal
import struct
import sys
from pathlib import Path
from unittest.mock import patch

from OpenSSL import SSL, crypto
from omp_away_tunnel.broker import Broker, Client, connect_local, connect_shared, read_frame, send_frame
from omp_away_tunnel.identity import IdentityStore, private_directory, read_private_json, write_private_json
from omp_away_tunnel.ipc import decode_frame
from omp_away_tunnel.transport import ProtocolError, SecureStream, encode
import test_relay


class Session:
    def __init__(self, init):
        self.init = init
        self.reader = self.writer = None
        self.seq = 0

    async def connect(self):
        async with asyncio.timeout(4):
            while self.writer is None:
                try:
                    self.reader, self.writer = await connect_local(self.init)
                except FileNotFoundError:
                    await asyncio.sleep(.01)

    async def expect(self, event=None):
        if self.writer is None:
            await self.connect()
        async with asyncio.timeout(4):
            kind, data = await read_frame(self.reader)
        if kind == 2:
            decoded = decode_frame(kind, data)
            msg = {key: value for key, value in decoded.items() if key not in ('op', 'id')}
            msg['event'] = 'pcm'
        else:
            msg = json.loads(data)
        if event is not None and msg.get('event') != event:
            raise AssertionError(f"expected {event}, got {msg.get('event')}")
        return msg

    async def command(self, op, **args):
        self.seq += 1
        if op == 'pcm':
            device = args['deviceId'].encode('ascii')
            data = struct.pack('!IB', self.seq, len(device)) + device + bytes.fromhex(args['ref']) + args['pcm']
            send_frame(self.writer, 2, data)
        else:
            send_frame(self.writer, 1, encode({'op': op, 'id': self.seq, **args}))
        reply = await self.expect('reply')
        if reply['id'] != self.seq:
            raise AssertionError('reply crossed session boundary')
        return reply

    async def routing(self, **patch):
        self.seq += 1
        send_frame(self.writer, 1, encode({'op': 'routing', 'id': self.seq, 'patch': patch}))
        snapshot = await self.expect('routing')
        reply = await self.expect('reply')
        if reply.get('id') != self.seq or reply.get('ok') is not True or reply.get('value') != snapshot['preferences']:
            raise AssertionError('routing snapshot was not acknowledged')
        return snapshot['preferences']

    async def close(self):
        if self.writer is not None and not self.writer.is_closing():
            send_frame(self.writer, 1, encode({'op': 'close'}))
            await self.writer.drain()
            self.writer.close()
            await self.writer.wait_closed()


class SharedHost:
    def __init__(self, init):
        self.broker = Broker(init)
        self.local = Session(init)
        self.read = self.broker.read
        self.event = self.broker.event
        self.media = self.broker.media
        self.expect = self.local.expect
        self.command = self.local.command


class BrokerTest(test_relay.RelayTest):
    def make_ipc(self, init):
        self.sessions = []
        return SharedHost(init)

    async def run_service(self):
        await self.host.broker.run(self.service)

    async def test_question_metadata_is_owned_and_replayed_after_merged_snapshots(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = dict(deviceId='phone_1', ref=connected['ref'])
        await phone.send_json(dict(type='list', details=True))
        for session in (self.host.local, second):
            await session.expect('message')
        await second.command('control', **dest, message=dict(type='inbox', items=[]))
        a = dict(requestId='a', project='A', question='Question A', createdAt=1)
        b = dict(requestId='b', project='B', question='Question B', createdAt=2)
        display = dict(v=1, context='', fields=[dict(id='f1', label='Choice', kind='single', required=False,
                       options=[dict(id='o1', label='Safe label', disabled=False)])])
        detail = dict(type='question', requestId='a', display=display)
        self.assertTrue((await self.host.command('control', **dest, message=dict(type='inbox', items=[a])))['ok'])
        await phone.read_frame()
        self.assertTrue((await self.host.command('control', **dest, message=detail))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), detail)
        self.assertFalse((await second.command('control', **dest, message=detail))['ok'])
        self.assertTrue((await second.command('control', **dest, message=dict(type='inbox', items=[b])))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=[a, b]))
        self.assertEqual(json.loads((await phone.read_frame())[1]), detail)
        # Each generation buffers fresh detail until the complete snapshot;
        # the next generation cannot replay the preceding generation's cache.
        for generation in range(2):
            await phone.send_json(dict(type='list', details=True))
            for session in (self.host.local, second):
                await session.expect('message')
            await self.host.command('control', **dest, message=dict(type='inbox', items=[a]))
            if generation == 0:
                await self.host.command('control', **dest, message=detail)
            await second.command('control', **dest, message=dict(type='inbox', items=[b]))
            self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=[a, b]))
            if generation == 0:
                self.assertEqual(json.loads((await phone.read_frame())[1]), detail)
        await phone.send_json(dict(type='join', requestId='a'))
        await self.host.expect('message')
        await self.host.command('control', **dest, message=dict(type='joined', requestId='a'))
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='joined', requestId='a'))
        await self.host.command('control', **dest, message=dict(type='ended', requestId='a'))
        await phone.read_frame()
        self.assertTrue((await self.host.command('control', **dest, message=dict(type='inbox', items=[])))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=[b]))
        self.assertFalse((await self.host.command('control', **dest, message=detail))['ok'])

    async def test_retirement_posts_only_opaque_routes_and_rejects_another_session(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = dict(deviceId='phone_1', ref=connected['ref'])
        item = dict(requestId='private-request', project='Private project', question='Private question', createdAt=1)
        await self.host.command('control', **dest, message=dict(type='inbox', items=[item]))
        await phone.read_frame()
        route = dict(deviceId='phone_1', requestId='private-request')
        self.assertTrue((await self.host.command('ring', **route))['ok'])
        self.assertFalse((await second.command('invalidate', **route))['ok'])
        self.assertFalse((await self.host.command('invalidate', **route, question='leak'))['ok'])
        self.assertTrue((await self.host.command('invalidate', **route))['ok'])
        self.assertEqual(self.invites, [route])
        self.assertEqual(self.invalidations, [route])
        self.assertNotIn(b'Private question', self.capture)

    async def test_session_loss_wakes_previously_invited_offline_phone(self):
        identity = IdentityStore(self.root / 'phone')
        self.service.identity.register('phone_1', identity.pin)
        route = dict(deviceId='phone_1', requestId='request-offline')
        self.assertTrue((await self.host.command('ring', **route))['ok'])
        await self.host.local.close()
        async with asyncio.timeout(4):
            while not self.invalidations:
                await asyncio.sleep(.01)
        self.assertEqual(self.invalidations, [route])

    async def test_active_proposal_survives_other_owner_snapshot_but_not_call_end(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = dict(deviceId='phone_1', ref=connected['ref'])
        await phone.send_json(dict(type='list', details=True))
        for session in (self.host.local, second):
            await session.expect('message')
        await second.command('control', **dest, message=dict(type='inbox', items=[]))
        item = dict(requestId='a', project='A', question='Choose', createdAt=1)
        await self.host.command('control', **dest, message=dict(type='inbox', items=[item]))
        await phone.read_frame()
        await phone.send_json(dict(type='join', requestId='a'))
        await self.host.expect('message')
        await self.host.command('control', **dest, message=dict(type='joined', requestId='a'))
        await phone.read_frame()
        proposal = dict(type='proposal', requestId='a', text='Choose: Safe label')
        self.assertFalse((await second.command('control', **dest, message=proposal))['ok'])
        self.assertTrue((await self.host.command('control', **dest, message=proposal))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), proposal)
        await second.command('control', **dest, message=dict(type='inbox', items=[]))
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=[item]))
        self.assertEqual(json.loads((await phone.read_frame())[1]), proposal)
        await self.host.command('control', **dest, message=dict(type='ended', requestId='a'))
        await phone.read_frame()
        await second.command('control', **dest, message=dict(type='inbox', items=[]))
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=[item]))
        # A following control remains next; no retired proposal was replayed.
        await self.host.command('control', **dest, message=dict(type='error', code='voice-unavailable'))
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='error', code='voice-unavailable'))

    async def test_failed_retirement_delivery_retries_after_owning_session_exits(self):
        identity = IdentityStore(self.root / 'phone')
        self.service.identity.register('phone_1', identity.pin)
        self.fail_invalidations = 1
        route = dict(deviceId='phone_1', requestId='retired-offline')
        self.assertTrue((await self.host.command('ring', **route))['ok'])
        self.assertTrue((await self.host.command('invalidate', **route))['ok'])
        self.assertEqual(self.invalidations, [])
        await self.host.local.close()
        async with asyncio.timeout(4):
            while not self.invalidations:
                await asyncio.sleep(.01)
        self.assertEqual(self.invalidations, [route])

    async def test_oversized_merged_snapshot_cannot_retire_or_replace_other_owners(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = dict(deviceId='phone_1', ref=connected['ref'])
        await phone.send_json(dict(type='list', details=True))
        for session in (self.host.local, second):
            await session.expect('message')
        await second.command('control', **dest, message=dict(type='inbox', items=[]))
        a = [dict(requestId=f'a{i}', project='A' * 128, question='Q' * 256, createdAt=i) for i in range(80)]
        b = [dict(requestId=f'b{i}', project='B' * 128, question='R' * 256, createdAt=i + 100) for i in range(80)]
        self.assertTrue((await self.host.command('control', **dest, message=dict(type='inbox', items=a)))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=a))
        self.assertFalse((await second.command('control', **dest, message=dict(type='inbox', items=b)))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='error', code='inbox-too-large'))
        self.assertTrue((await second.command('control', **dest, message=dict(type='inbox', items=b[:1])))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=a + b[:1]))

    async def test_reconciliation_owner_loss_completes_only_remaining_owners_snapshot(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = dict(deviceId='phone_1', ref=connected['ref'])
        a = dict(requestId='a', project='A', question='A?', createdAt=1)
        b = dict(requestId='b', project='B', question='B?', createdAt=2)
        await self.host.command('control', **dest, message=dict(type='inbox', items=[a]))
        await phone.read_frame()
        await second.command('control', **dest, message=dict(type='inbox', items=[b]))
        await phone.read_frame()
        await phone.send_json(dict(type='list', details=True))
        for session in (self.host.local, second):
            await session.expect('message')
        await self.host.command('control', **dest, message=dict(type='inbox', items=[a]))
        waiting = asyncio.create_task(phone.read_frame())
        await asyncio.sleep(.02)
        self.assertFalse(waiting.done())
        await second.close()
        self.assertEqual(json.loads((await waiting)[1]), dict(type='inbox', items=[a]))

    async def test_reconciliation_timeout_is_not_a_partial_snapshot_and_can_retry(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = dict(deviceId='phone_1', ref=connected['ref'])
        a = dict(requestId='a', project='A', question='A?', createdAt=1)
        b = dict(requestId='b', project='B', question='B?', createdAt=2)
        await self.host.command('control', **dest, message=dict(type='inbox', items=[a]))
        await phone.read_frame()
        await second.command('control', **dest, message=dict(type='inbox', items=[b]))
        await phone.read_frame()
        await phone.send_json(dict(type='list', details=True))
        for session in (self.host.local, second):
            await session.expect('message')
        await self.host.command('control', **dest, message=dict(type='inbox', items=[a]))
        async with asyncio.timeout(6):
            self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='error', code='inbox-unavailable'))
        await phone.send_json(dict(type='list', details=True))
        for session in (self.host.local, second):
            await session.expect('message')
        await self.host.command('control', **dest, message=dict(type='inbox', items=[a]))
        await second.command('control', **dest, message=dict(type='inbox', items=[b]))
        self.assertEqual(json.loads((await phone.read_frame())[1]), dict(type='inbox', items=[a, b]))

    async def asyncTearDown(self):
        # Fixture shutdown must not turn session disconnects into new HTTPS wakeups.
        self.host.broker.stop()
        await self.host.local.close()
        for session in self.sessions:
            await session.close()
        await super().asyncTearDown()

    async def session(self):
        session = Session(self.host.broker.init)
        self.sessions.append(session)
        await session.expect('ready')
        return session

    async def phone(self, registered=True):
        identity = IdentityStore(self.root / 'phone')
        if registered:
            self.service.identity.register('phone_1', identity.pin)
        control = await self.control_ready.get()
        await control.send_json({'type': 'connect', 'deviceId': 'phone_1', 'connectionId': 'connection_1'})
        ws = await asyncio.wait_for(self.desktop_ready.get(), 4)
        context = SSL.Context(SSL.TLS_CLIENT_METHOD)
        context.set_min_proto_version(SSL.TLS1_3_VERSION)
        context.get_cert_store().add_cert(crypto.X509.from_cryptography(self.service.identity.cert))
        context.set_verify(SSL.VERIFY_PEER, lambda conn, cert, err, depth, ok: ok)
        context.use_certificate(identity.cert)
        context.use_privatekey(identity.key)
        phone = SecureStream(context, ws, False)
        await phone.handshake(self.service.identity.pin)
        return phone

    async def test_routing_updates_all_subscribers_once_and_new_sessions_inherit(self):
        first, second = self.host.local, await self.session()
        legacy = await self.session()
        self.assertEqual(await first.routing(), {'away': False, 'delayMs': None})
        await second.routing()
        enabled = {'away': True, 'delayMs': None}
        self.assertEqual(await first.routing(away=True), enabled)
        self.assertEqual((await second.expect('routing'))['preferences'], enabled)
        self.assertEqual(await first.routing(away=True), enabled)
        self.assertTrue((await second.command('devices'))['ok'])
        self.assertTrue((await legacy.command('devices'))['ok'])
        third = await self.session()
        self.assertEqual(await third.routing(), enabled)
        disabled = {'away': False, 'delayMs': None}
        self.assertEqual(await second.routing(away=False), disabled)
        for session in (first, third):
            self.assertEqual((await session.expect('routing'))['preferences'], disabled)

    async def test_concurrent_routing_patches_preserve_each_other_and_survive_broker_restart(self):
        first, second = self.host.local, await self.session()
        await first.routing()
        await second.routing()
        for session, change in ((first, {'away': True}), (second, {'delayMs': 30000})):
            session.seq += 1
            send_frame(session.writer, 1, encode({'op': 'routing', 'id': session.seq, 'patch': change}))
        expected = {'away': True, 'delayMs': 30000}
        for session in (first, second):
            messages = [await session.expect() for _ in range(3)]
            snapshots = [msg['preferences'] for msg in messages if msg['event'] == 'routing']
            self.assertEqual(snapshots[-1], expected)
            self.assertEqual(len([msg for msg in messages if msg['event'] == 'reply' and msg['ok']]), 1)
        await first.close()
        await second.close()
        self.host.broker.stop()
        await asyncio.wait_for(self.worker, 5)
        init = self.host.broker.init
        self.host = SharedHost(init)
        self.service = test_relay.Service(init, self.host, self.client)
        self.worker = asyncio.create_task(self.run_service())
        await self.host.expect('ready')
        self.assertEqual(await self.host.local.routing(), expected)

    async def test_invalid_routing_and_failed_persistence_do_not_change_other_sessions(self):
        first, second = self.host.local, await self.session()
        enabled = {'away': True, 'delayMs': None}
        await first.routing(away=True)
        await second.routing()
        for invalid in ({'away': 1}, {'delayMs': True}, {'delayMs': -1}, {'delayMs': 2147483648}, {'unknown': True}, []):
            self.assertFalse((await first.command('routing', patch=invalid))['ok'])
        with patch('omp_away_tunnel.broker.save_preferences', side_effect=PermissionError('test write denied')):
            self.assertFalse((await first.command('routing', patch={'away': False}))['ok'])
        self.assertEqual(await first.routing(), enabled)
        self.assertTrue((await second.command('devices'))['ok'])
        self.assertEqual(read_private_json(Path(self.host.broker.init['stateDir']) / 'routing.json'), enabled)

    async def test_invalid_saved_routing_cannot_publish_a_default_off_broker(self):
        directory = self.root / 'invalid-routing'
        private_directory(directory)
        write_private_json(directory / 'routing.json', {'away': True})
        broker = Broker({**self.host.broker.init, 'stateDir': str(directory)})
        async with asyncio.timeout(2):
            with self.assertRaises(ProtocolError):
                await broker.run(self.service)
        self.assertFalse((directory / 'gateway.json').exists())

    async def run_desktops(self, mode):
        bun = shutil.which('bun')
        if bun is None:
            self.skipTest('Bun is required for the TypeScript gateway integration')
        init = self.host.broker.init
        token = Path(init['stateDir']) / f'test-token-{mode}'
        with os.fdopen(os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
            file.write(init['desktopToken'])
        fixture = Path(__file__).resolve().parents[2] / 'test' / 'fixtures' / 'shared-routing.ts'
        child = await asyncio.create_subprocess_exec(bun, str(fixture), stdin=asyncio.subprocess.PIPE,
                                                     stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, error = await asyncio.wait_for(child.communicate(encode({
                **init, 'python': sys.executable, 'tokenFile': str(token), 'mode': mode,
            })), 30)
            self.assertEqual(child.returncode, 0, error.decode(errors='replace'))
            return json.loads(output)
        finally:
            if child.returncode is None:
                child.kill()
            await child.wait()

    async def test_real_typescript_admin_commands_share_routing_across_gateway_clients(self):
        self.assertEqual(await self.run_desktops('normal'), {
            'globalEnable': True, 'inherited': True, 'globalDisable': True, 'originExitSafe': True,
        })
        self.assertEqual(await self.host.local.routing(), {'away': True, 'delayMs': 30000})
        self.assertEqual(self.control_ready.qsize(), 1)

    async def test_real_typescript_gateway_rejects_legacy_broker_and_malformed_snapshot(self):
        original = Client.event
        for mode in ('legacy', 'malformed'):
            with self.subTest(mode=mode):
                def altered(client, **message):
                    if mode == 'legacy' and message.get('event') == 'ready':
                        message.pop('routingVersion', None)
                    elif mode == 'malformed' and message.get('event') == 'routing':
                        message['preferences'] = {'away': 'on', 'delayMs': None}
                    original(client, **message)
                with patch.object(Client, 'event', altered):
                    self.assertEqual(await self.run_desktops(mode), {'rejected': True})
                self.assertTrue((await self.host.command('devices'))['ok'])
        self.assertEqual(self.control_ready.qsize(), 1)

    async def test_two_sessions_merge_inboxes_but_isolate_calls_and_survive_first_session_exit(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        self.assertEqual(await second.expect('connected'), connected)
        dest = {'deviceId': 'phone_1', 'ref': connected['ref']}
        a = {'requestId': 'request_a', 'project': 'A', 'question': 'Choose A', 'createdAt': 1}
        b = {'requestId': 'request_b', 'project': 'B', 'question': 'Choose B', 'createdAt': 2}
        for session, item, expected in [(self.host.local, a, [a]), (second, b, [a, b])]:
            self.assertTrue((await session.command('control', **dest, message={'type': 'inbox', 'items': [item]}))['ok'])
            self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'inbox', 'items': expected})
        self.assertFalse((await second.command('control', **dest, message={'type': 'inbox', 'items': [a]}))['ok'])
        await phone.send_json({'type': 'join', 'requestId': 'request_b'})
        self.assertEqual((await second.expect('message'))['message']['requestId'], 'request_b')
        self.assertTrue((await self.host.command('devices'))['ok'])  # No leaked join ahead of the reply.
        self.assertFalse((await self.host.command('control', **dest, message={'type': 'joined', 'requestId': 'request_b'}))['ok'])
        self.assertTrue((await second.command('control', **dest, message={'type': 'joined', 'requestId': 'request_b'}))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'joined', 'requestId': 'request_b'})
        pcm = secrets.token_bytes(960)
        await phone.send_frame(2, pcm)
        self.assertEqual((await second.expect('pcm'))['pcm'], pcm)
        self.assertTrue((await self.host.command('devices'))['ok'])  # No leaked microphone frame.
        self.assertFalse((await self.host.command('pcm', **dest, pcm=pcm))['ok'])
        self.assertFalse((await second.command('control', **dest, message={'type': 'ended', 'requestId': 'request_a'}))['ok'])
        await self.host.local.close()
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'inbox', 'items': [b]})
        self.assertTrue((await second.command('pcm', **dest, pcm=pcm))['ok'])
        self.assertEqual(await phone.read_frame(), (2, pcm))
        await second.close()
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'ended', 'requestId': 'request_b'})
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'inbox', 'items': []})
        third = await self.session()
        self.assertEqual(await third.expect('connected'), connected)
        self.assertEqual((await third.command('devices'))['value'], ['phone_1'])
        self.assertTrue(self.control_ready.empty())  # No second relay owner was opened.

    async def test_only_enrollment_initiator_can_approve_pairing(self):
        second = await self.session()
        qr = (await self.host.command('pair'))['value']
        self.assertFalse((await second.command('pair'))['ok'])
        phone = await self.phone(registered=False)
        await phone.send_json({'type': 'pair', 'nonce': qr['nonce'], 'secret': qr['secret']})
        verify = json.loads((await phone.read_frame())[1])
        prompt = await self.host.expect('confirm')
        self.assertEqual(verify['emoji'], prompt['emoji'])
        self.assertFalse((await second.command('confirm', ref=prompt['ref'], accept=True))['ok'])
        self.assertEqual(self.service.identity.peers, {})
        await phone.send_json({'type': 'verify', 'accept': True})
        self.assertTrue((await self.host.command('confirm', ref=prompt['ref'], accept=True))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'paired'})
        self.assertEqual((await self.host.expect('connected'))['deviceId'], 'phone_1')
        self.assertEqual((await second.expect('connected'))['deviceId'], 'phone_1')

    async def test_wrong_local_auth_or_configuration_cannot_replace_the_gateway(self):
        endpoint = read_private_json(Path(self.host.broker.init['stateDir']) / 'gateway.json')
        reader, writer = await asyncio.open_connection('127.0.0.1', endpoint['port'])
        send_frame(writer, 1, encode({'auth': secrets.token_urlsafe(32), 'config': endpoint['config']}))
        async with asyncio.timeout(4):
            self.assertEqual(await reader.read(), b'')
        writer.close()
        await writer.wait_closed()
        with self.assertRaises(ProtocolError):
            await connect_shared({**self.host.broker.init, 'desktopToken': secrets.token_urlsafe(32)})
        self.assertEqual((await self.host.command('devices'))['value'], [])
        self.assertEqual(self.control_ready.qsize(), 1)

    async def test_failure_after_ended_is_delivered_only_by_its_owner(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = {'deviceId': 'phone_1', 'ref': connected['ref']}
        item = {'requestId': 'request_a', 'project': 'A', 'question': 'Choose A', 'createdAt': 1}
        await self.host.command('control', **dest, message={'type': 'inbox', 'items': [item]})
        await phone.read_frame()
        self.assertFalse((await second.command('ring', deviceId='phone_1', requestId='request_a'))['ok'])
        await phone.send_json({'type': 'join', 'requestId': 'request_a'})
        await self.host.expect('message')
        await self.host.command('control', **dest, message={'type': 'joined', 'requestId': 'request_a'})
        await phone.read_frame()
        self.assertTrue((await self.host.command('control', **dest, message={'type': 'ended', 'requestId': 'request_a'}))['ok'])
        await phone.read_frame()
        error = {'type': 'error', 'code': 'voice-unavailable'}
        self.assertFalse((await second.command('control', **dest, message=error))['ok'])
        self.assertTrue((await self.host.command('control', **dest, message=error))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), error)

    async def test_completed_call_tail_is_discarded_and_next_call_keeps_its_owner(self):
        phone = await self.phone()
        connected = await self.host.expect('connected')
        second = await self.session()
        await second.expect('connected')
        dest = {'deviceId': 'phone_1', 'ref': connected['ref']}
        items = []
        for session, request in [(self.host.local, 'request_a'), (second, 'request_b')]:
            item = {'requestId': request, 'project': 'Test', 'question': 'Choose', 'createdAt': 1}
            items.append(item)
            self.assertTrue((await session.command('control', **dest, message={'type': 'inbox', 'items': [item]}))['ok'])
            await phone.read_frame()
        await phone.send_json({'type': 'join', 'requestId': 'request_a'})
        await self.host.expect('message')
        self.assertTrue((await self.host.command('control', **dest, message={'type': 'joined', 'requestId': 'request_a'}))['ok'])
        await phone.read_frame()
        await phone.send_frame(2, b'a' * 960)
        self.assertEqual((await self.host.expect('pcm'))['pcm'], b'a' * 960)
        mark = {'type': 'mark', 'requestId': 'request_a', 'mark': 'tail-mark'}
        self.assertTrue((await self.host.command('control', **dest, message=mark))['ok'])
        await phone.read_frame()
        self.assertTrue((await self.host.command('control', **dest, message={'type': 'ended', 'requestId': 'request_a'}))['ok'])
        # Send the already-captured microphone tail before observing the desktop's end.
        await phone.send_frame(2, b'x' * 960)
        await phone.send_frame(2, b'y' * 960)
        await phone.send_json({'type': 'hangup', 'requestId': 'request_a'})
        await phone.send_json({'type': 'played', 'requestId': 'request_a', 'mark': 'tail-mark'})
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'ended', 'requestId': 'request_a'})
        await phone.send_json({'type': 'list', 'details': True})
        for session in (self.host.local, second):
            # The ordered list fences the tail: no PCM, error, hangup, or lost event leaked.
            self.assertEqual((await session.expect('message'))['message'], {'type': 'list', 'details': True})
        # Preserve the release's complete-snapshot handshake before the next call.
        for session, item in zip((self.host.local, second), items):
            self.assertTrue((await session.command('control', **dest, message={'type': 'inbox', 'items': [item]}))['ok'])
        self.assertEqual(json.loads((await phone.read_frame())[1]), {'type': 'inbox', 'items': items})
        await phone.send_json({'type': 'join', 'requestId': 'request_b'})
        self.assertEqual((await second.expect('message'))['message']['requestId'], 'request_b')
        self.assertTrue((await second.command('control', **dest, message={'type': 'joined', 'requestId': 'request_b'}))['ok'])
        await phone.read_frame()
        await phone.send_frame(2, b'b' * 960)
        self.assertEqual((await second.expect('pcm'))['pcm'], b'b' * 960)
        self.assertTrue((await self.host.command('devices'))['ok'])
        self.assertFalse((await self.host.command('pcm', **dest, pcm=b'z' * 960))['ok'])
        self.assertTrue(self.control_ready.empty())

    async def test_simultaneous_proxy_processes_elect_one_gateway_that_survives_its_first_parent(self):
        init = {**self.host.broker.init, 'stateDir': str(self.root / 'process-desktop')}
        fixture = Path(__file__).with_name('gateway_child.py')
        certificate = self.root / 'test-certificate' / 'cert'
        endpoint = Path(init['stateDir']) / 'gateway.json'
        children = []
        async def start():
            child = await asyncio.create_subprocess_exec(sys.executable, '-I', str(fixture), str(certificate),
                                                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.PIPE)
            children.append(child)
            send_frame(child.stdin, 1, encode(init))
            async with asyncio.timeout(25):
                kind, data = await read_frame(child.stdout)
            self.assertEqual((kind, json.loads(data)), (1, {'event': 'ready', 'routingVersion': 1}))
            return child
        try:
            first, second = await asyncio.gather(start(), start())
            self.assertEqual(self.control_ready.qsize(), 2)  # Existing fixture + one new shared owner.
            send_frame(first.stdin, 1, encode({'op': 'close'}))
            first.stdin.close()
            await asyncio.wait_for(first.wait(), 4)
            send_frame(second.stdin, 1, encode({'op': 'devices', 'id': 1}))
            async with asyncio.timeout(4):
                kind, data = await read_frame(second.stdout)
            self.assertEqual((kind, json.loads(data)), (1, {'event': 'reply', 'id': 1, 'ok': True, 'value': []}))
            self.assertEqual(self.control_ready.qsize(), 2)
            second.stdin.close()
            await asyncio.wait_for(second.wait(), 4)
            async with asyncio.timeout(15):
                while endpoint.exists():
                    await asyncio.sleep(.05)
        finally:
            for child in children:
                if child.returncode is None:
                    child.kill()
                await child.wait()
            if endpoint.exists():
                for pid in (certificate.parent / 'broker-pids').read_text().splitlines():
                    try:
                        os.kill(int(pid), signal.SIGTERM)
                    except ProcessLookupError:
                        pass
