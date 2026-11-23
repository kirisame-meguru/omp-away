import json
from pathlib import Path
import tempfile
import unittest

from smoke_relay import synthetic_environment


class NativeSmokeTests(unittest.TestCase):
    def test_smoke_uses_only_disposable_adc_and_disables_external_proxy_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = synthetic_environment(root, 18787, {'PATH': 'tools', 'SYSTEMROOT': 'system',
                'GOOGLE_APPLICATION_CREDENTIALS': 'real-secret', 'AWAY_DESKTOP_TOKEN_FILE': 'real-token',
                'GOOGLE_CLOUD_PROJECT': 'real-project', 'OPENAI_API_KEY': 'real-key'})
            self.assertEqual(env['AWAY_LISTEN'], '127.0.0.1:18787')
            self.assertEqual(env['GOOGLE_CLOUD_PROJECT'], 'away-smoke')
            self.assertEqual(env['GOOGLE_APPLICATION_CREDENTIALS'], str(root / 'synthetic-adc.json'))
            self.assertNotIn('OPENAI_API_KEY', env)
            self.assertEqual(env['HTTPS_PROXY'], 'http://127.0.0.1:9')
            adc = json.loads((root / 'synthetic-adc.json').read_text())
            self.assertEqual(adc['type'], 'authorized_user')
            self.assertEqual(adc['client_id'], 'synthetic-smoke.example.invalid')
            self.assertNotIn('private_key', adc)
            token = (root / 'desktop-token').read_text()
            self.assertEqual(len(token), 43)
            self.assertTrue((root / 'state').is_dir())


if __name__ == '__main__':
    unittest.main()
