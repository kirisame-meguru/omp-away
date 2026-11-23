import os
from pathlib import Path
import tempfile
import unittest

from install_plugin import isolated_environment, provisioning_commands


class InstallerTests(unittest.TestCase):
    def test_isolated_install_does_not_inherit_credentials_or_user_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = isolated_environment(Path(tmp), {'PATH': 'tools', 'OPENAI_API_KEY': 'secret',
                                      'OMP_PROFILE': 'personal', 'PI_CODING_AGENT_DIR': 'private',
                                      'HOME': 'private', 'XDG_CONFIG_HOME': 'private'})
            self.assertEqual(env['HOME'], str(Path(tmp)))
            self.assertEqual(env['USERPROFILE'], str(Path(tmp)))
            self.assertNotIn('OPENAI_API_KEY', env)
            self.assertNotIn('OMP_PROFILE', env)
            self.assertEqual(env['PI_CODING_AGENT_DIR'], str(Path(tmp) / '.omp/agent'))
            self.assertNotEqual(env['XDG_CONFIG_HOME'], 'private')

    def test_helpers_are_frozen_and_provisioned_before_actual_local_link(self):
        root = Path('/example/archive').resolve()
        commands = provisioning_commands(root, 'omp-pinned')
        self.assertEqual(commands[0], ['bun', 'install', '--frozen-lockfile', '--production'])
        self.assertEqual(commands[1], ['uv', 'sync', '--locked', '--no-dev', '--python', '3.12.8', '--project', str(root / 'plugin/tunnel')])
        self.assertEqual(commands[2], ['uv', 'sync', '--locked', '--no-dev', '--python', '3.12.8', '--project', str(root / 'plugin/media')])
        self.assertEqual(commands[3], ['omp-pinned', 'install', str(root / 'plugin')])


if __name__ == '__main__':
    unittest.main()
