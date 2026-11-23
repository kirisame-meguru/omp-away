"""Offline target-configuration coverage; never contact infrastructure or devices."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import operator_run
import verify


class TargetTests(unittest.TestCase):
    def test_cli_requires_both_explicit_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = str(Path(tmp) / 'missing')
            for script, prefix in (('operator_run.py', ['live', directory, '--serial', 'emulator-5554']),
                                   ('verify.py', [directory])):
                for options, missing in (([], '--relay-host'), (['--avd', 'Approved_Test'], '--relay-host'),
                                         (['--relay-host', 'relay.example.invalid'], '--avd')):
                    with self.subTest(script=script, options=options):
                        result = subprocess.run([sys.executable, str(Path(__file__).with_name(script)), *prefix, *options],
                                                capture_output=True, text=True, timeout=10)
                        self.assertEqual(result.returncode, 2)
                        self.assertIn(missing, result.stderr)
                        self.assertFalse(Path(directory).exists())

    def test_blank_targets_fail_before_reading_evidence_or_invoking_adb(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'missing'
            for host, avd in (('', 'Approved_Test'), ('  ', 'Approved_Test'), ('relay.example.invalid', ''),
                              ('relay.example.invalid', '\t')):
                with self.subTest(host=host, avd=avd):
                    with self.assertRaisesRegex(ValueError, 'relay host|AVD'):
                        operator_run.live(missing, 'must-not-run', 'emulator-5554', 'human-mic', host, avd)
                    with self.assertRaisesRegex(ValueError, 'relay host|AVD'):
                        verify.verify(missing, host, avd)
            self.assertFalse(missing.exists())

    def test_collector_records_supplied_target_and_rejects_other_device(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'scenario.json').write_text(json.dumps({'run': 'a' * 32, 'note': 'retry tomorrow'}))
            notifications = iter(['', '0|ru.eleven.ompaway|1|11111111-1111-1111-1111-111111111111', ''])
            def adb(command, **kwargs):
                self.assertEqual(command[:3], ['offline-adb', '-s', 'emulator-5554'])
                args = command[3:]
                if args == ['emu', 'avd', 'name']:
                    output = 'Approved_Test\nOK'
                elif args == ['shell', 'dumpsys', 'package', operator_run.PKG]:
                    output = 'versionName=1.0\nversionCode=5\nandroid.permission.POST_NOTIFICATIONS: granted=true'
                elif args == ['shell', 'pm', 'path', operator_run.PKG]:
                    output = 'package:/data/app/test/base.apk'
                elif args == ['shell', 'sha256sum', '/data/app/test/base.apk']:
                    output = 'a' * 64 + '  /data/app/test/base.apk'
                elif args == ['shell', 'getprop', 'ro.build.id']:
                    output = 'TEST.1'
                elif args == ['shell', 'cmd', 'notification', 'list']:
                    output = next(notifications)
                elif args == ['shell', 'dumpsys', 'window', 'windows']:
                    output = 'mCurrentFocus=ru.eleven.ompaway/InboxActivity'
                else:
                    self.fail('Unexpected device operation')
                return subprocess.CompletedProcess(command, 0, output.encode(), b'')
            with patch.object(operator_run.subprocess, 'run', side_effect=adb), patch('builtins.input', return_value='SEEN'), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'approved AVD'):
                    operator_run.live(root, 'offline-adb', 'emulator-5554', 'human-mic', 'relay.example.invalid', 'Other_Test')
                self.assertFalse((root / 'android.json').exists())
                operator_run.live(root, 'offline-adb', 'emulator-5554', 'human-mic', 'relay.example.invalid', 'Approved_Test')
            evidence = json.loads((root / 'android.json').read_text())
            self.assertEqual(evidence['route'], 'relay.example.invalid')
            self.assertEqual(evidence['avd'], 'Approved_Test')

    def test_verifier_checks_supplied_targets_not_inherited_defaults(self):
        run, request, mark, utterance = 'a' * 32, 'b' * 64, 'c' * 64, 'd' * 64
        decisions = [{'event': name, 'at': i + 1, 'request': request,
                      ('mark' if i < 5 else 'utterance'): mark if i < 5 else utterance}
                     for i, name in enumerate(['readback', 'verified', 'mark', 'presented', 'played', 'speech-start', 'user-final', 'accepted'])]
        decisions[0]['draftValues'] = {'mode': 'blue', 'note': 'retry tomorrow'}
        decisions[3].update(targetFrames=1, presentedFrames=1)
        network = dict.fromkeys(['run', 'startMs', 'endMs', 'dropped', 'uidCoverage', 'ipCoverage', 'unclassified', 'flows',
                                 'fcmAcceptedMs', 'fcmRequest', 'liveModel', 'liveObservation', 'pairing', 'relayStartMs',
                                 'relayEndMs', 'relayDrops', 'relayStreams'])
        network['run'] = run
        device = {'run': run, 'request': request, 'avd': 'Approved_Test', 'package': 'ru.eleven.ompaway',
                  'serial': 'emulator-5554', 'apkSha256': 'e' * 64, 'version': '1', 'build': 'TEST',
                  'route': 'relay.example.invalid', 'notificationPermission': True, 'audioSource': 'human-mic'}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, value in {'scenario.json': {'run': run, 'note': 'retry tomorrow'}, 'android.json': device,
                                'network.json': network, 'relay.json': {'run': run},
                                'invite.json': {'run': run, 'request': request, 'status': 204}}.items():
                (root / name).write_text(json.dumps(value))
            (root / 'decision.ndjson').write_text('\n'.join(map(json.dumps, decisions)))
            (root / 'host.ndjson').write_text('')
            for host, avd, reason in [('other.example.invalid', 'Approved_Test', 'bad handset baseline'),
                                      ('relay.example.invalid', 'Other_Test', 'wrong handset'),
                                      ('relay.example.invalid', 'Approved_Test', 'unexpected or missing host events')]:
                with self.subTest(host=host, avd=avd), self.assertRaisesRegex(ValueError, reason):
                    verify.verify(root, host, avd)


if __name__ == '__main__':
    unittest.main()
