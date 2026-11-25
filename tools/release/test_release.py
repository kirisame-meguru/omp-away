"""Portable tests of the exact scripts used by CI; no SDK, network or credentials."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import release
import publish


class ReleaseTests(unittest.TestCase):
    def test_versions_sort_and_reject_noncanonical_tags(self):
        self.assertEqual(release.version_code('v1.0.5'), 1000005)
        self.assertLess(release.version_code('v1.999.999'), release.version_code('v2.0.0'))
        for tag in ('v01.0.1', 'v1.0.0-rc1', 'v1.1000.0', 'v2100.0.0', '../v1.0.0'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.version_code(tag)

    def test_beta_android_updates_remain_ordered_through_stable(self):
        tags = ['v1.0.22', 'v1.0.23-beta.1', 'v1.0.23-beta.2',
                'v1.0.23-beta.98', 'v1.0.23', 'v1.0.24-beta.1']
        codes = [release.version_code(tag) for tag in tags]
        self.assertEqual(codes[0], 1000022)
        self.assertEqual(codes[1], 100002301)
        self.assertTrue(all(a < b for a, b in zip(codes, codes[1:])))
        for tag in ('v1.0.22-beta.1', 'v1.0.23-beta.0', 'v1.0.23-beta.01',
                    'v1.0.23-beta.99', 'v21.0.0'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.version_code(tag)

    def test_expected_set_includes_every_component_and_armv7(self):
        self.assertEqual(set(release.expected_assets('v1.0.5')), {
            'away-relay-v1.0.5-linux-amd64.tar.gz', 'away-relay-v1.0.5-linux-arm64.tar.gz',
            'away-relay-v1.0.5-linux-armv7.tar.gz', 'away-relay-v1.0.5-windows-amd64.zip',
            'away-relay-v1.0.5-windows-arm64.zip', 'away-relay-v1.0.5-darwin-amd64.tar.gz',
            'away-relay-v1.0.5-darwin-arm64.tar.gz', 'away-v1.0.5.apk',
            'omp-away-plugin-v1.0.5.zip', 'INSTALL.md', 'release.json', 'SHA256SUMS'})

    def test_missing_android_inputs_fail_before_build(self):
        with self.assertRaisesRegex(ValueError, 'AWAY_FIREBASE_CONFIG'):
            release.android_inputs({})
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'client.json'
            config.write_text(json.dumps({'type': 'service_account', 'private_key': 'not-a-key'}))
            env = {key: 'example' for key in release.ANDROID_INPUTS}
            env['AWAY_FIREBASE_CONFIG'] = str(config)
            env['AWAY_KEYSTORE'] = str(config)
            with self.assertRaisesRegex(ValueError, 'Android client'):
                release.android_inputs(env)

    def test_complete_manifest_checks_bytes_and_rejects_extra_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in release.expected_assets('v1.0.5') - {'release.json', 'SHA256SUMS'}:
                (root / name).write_bytes(b'fixture')
            release.seal(root, 'v1.0.5', 'a' * 40, 123)
            manifest = release.verify(root)
            self.assertEqual(manifest['commit'], 'a' * 40)
            (root / 'away-v1.0.5.apk').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                release.verify(root)
            (root / 'away-v1.0.5.apk').write_bytes(b'fixture')
            (root / 'private-key.jks').write_bytes(b'not-a-key')
            with self.assertRaisesRegex(ValueError, 'asset set'):
                release.verify(root)

    def test_missing_asset_cannot_be_sealed(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'asset set'):
                release.seal(Path(tmp), 'v1.0.5', 'a' * 40, 123)

    def test_checksums_reject_traversal_and_duplicates(self):
        for line in ('0' * 64 + '  ../outside\n', '0' * 64 + '  C:\\key\n',
                     '0' * 64 + '  file\n' + '0' * 64 + '  file\n'):
            with self.subTest(line=line), self.assertRaises(ValueError):
                release.parse_checksums(line)

    @unittest.skipIf(os.name == 'nt', 'Creating symlinks may require Windows elevation')
    def test_asset_set_rejects_symbolic_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'outside'
            source.write_bytes(b'private')
            assets = root / 'assets'
            assets.mkdir()
            (assets / 'entry').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                release.file_set(assets)

    def test_archives_are_deterministic_and_exclude_unlisted_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'entry').write_bytes(b'content')
            release.archive(root / 'first.zip', root, ['entry'], 123)
            release.archive(root / 'second.zip', root, ['entry'], 999)
            self.assertEqual((root / 'first.zip').read_bytes(), (root / 'second.zip').read_bytes())
            with zipfile.ZipFile(root / 'first.zip') as z:
                self.assertEqual(z.namelist(), ['entry'])
            with self.assertRaises(ValueError):
                release.archive(root / 'bad.zip', root, ['../outside'], 123)

    def test_plugin_archive_keeps_required_opening_prompt_without_media_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = {
                'package.json': '{}', 'bun.lock': '{}', 'src/index.ts': '// entry',
                'tunnel/pyproject.toml': '', 'tunnel/uv.lock': '',
                'media/pyproject.toml': '', 'media/uv.lock': '', 'media/peer.py': '# peer',
                'media/opening.md': 'Synthetic opening instructions',
                'media/diagnostics.json': 'private test fixture',
            }
            for name, content in files.items():
                target = root / 'plugin' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding='utf-8')
            for name in ('tools/release/install_plugin.py', 'docs/releases/INSTALL.md'):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('installer fixture', encoding='utf-8')
            output = root / 'out'
            output.mkdir()

            def command(args, cwd=None, env=None, capture=False):
                if args == ['git', 'ls-files', '-z', '--', 'plugin']:
                    return '\0'.join('plugin/' + name for name in files)
                if args == ['bun', 'media/build-sdk.ts']:
                    bundle = cwd / 'src/media/live-sdk.generated.mjs'
                    bundle.parent.mkdir(parents=True, exist_ok=True)
                    bundle.write_text('// generated SDK fixture', encoding='utf-8')
                elif args != ['bun', 'install', '--frozen-lockfile']:
                    raise AssertionError('unexpected build command')

            with patch.object(release, 'ROOT', root), patch.object(release, 'command', command):
                release.build_plugin(output, 'v1.0.22', 123)
            with zipfile.ZipFile(output / 'omp-away-plugin-v1.0.22.zip') as archive:
                self.assertEqual(archive.read('plugin/media/opening.md').decode(),
                                 files['media/opening.md'])
                self.assertNotIn('plugin/media/diagnostics.json', archive.namelist())


class HostTests(unittest.TestCase):
    def test_only_explicit_https_host_and_repository_are_accepted(self):
        config = publish.HostConfig('forgejo', 'https://forge.example.org',
                                    'https://forge.example.org/api/v1', 'team/away',
                                    'https://forge.example.org')
        self.assertEqual(config.repo_api, 'https://forge.example.org/api/v1/repos/team/away')
        for origin in ('http://forge.example.org', 'https://user:pass@forge.example.org',
                       'https://forge.example.org/path', 'https://forge.example.org?token=x',
                       'https://forge.example.org/#x', 'https://forge.example.org\\@evil.example'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                publish.HostConfig('forgejo', origin, origin + '/api/v1', 'team/away', origin)
        with self.assertRaises(ValueError):
            publish.HostConfig('forgejo', 'https://forge.example.org',
                               'https://other.example.org/api/v1', 'team/away', 'https://forge.example.org')

    def test_publication_resumes_draft_verifies_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.assets(Path(tmp))
            host = MemoryHost()
            publish.publish(root, host, finalize=False)
            self.assertTrue(host.release['draft'])
            self.assertEqual(len(host.data), 12)
            first = dict(host.data)
            publish.publish(root, host, finalize=True)
            self.assertFalse(host.release['draft'])
            publish.publish(root, host, finalize=True)
            self.assertEqual(first, host.data)
            self.assertEqual(host.creates, 1)

    def test_changed_remote_content_or_unexpected_asset_never_finalizes(self):
        for extra in (False, True):
            with tempfile.TemporaryDirectory() as tmp:
                root = self.assets(Path(tmp))
                host = MemoryHost()
                publish.publish(root, host, finalize=False)
                host.data['unexpected' if extra else 'INSTALL.md'] = b'changed'
                with self.assertRaises(ValueError):
                    publish.publish(root, host, finalize=True)
                self.assertTrue(host.release['draft'])

    def test_interrupted_upload_recovers_without_duplicate_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.assets(Path(tmp))
            host = MemoryHost(fail_after=3)
            with self.assertRaises(OSError):
                publish.publish(root, host, finalize=True)
            self.assertTrue(host.release['draft'])
            self.assertEqual(len(host.data), 3)
            host.fail_after = None
            publish.publish(root, host, finalize=True)
            self.assertFalse(host.release['draft'])
            self.assertEqual(len(host.data), 12)

    def test_published_incomplete_release_is_not_mutated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.assets(Path(tmp))
            host = MemoryHost()
            host.release = {'id': 1, 'draft': False, 'tag_name': 'v1.0.5', 'body': 'wrong'}
            with self.assertRaises(ValueError):
                publish.publish(root, host, finalize=True)
            self.assertEqual(host.data, {})

    @staticmethod
    def assets(root):
        for name in release.expected_assets('v1.0.5') - {'release.json', 'SHA256SUMS'}:
            (root / name).write_bytes(b'fixture')
        release.seal(root, 'v1.0.5', 'a' * 40, 123)
        return root


class MemoryHost:
    """Only the external release API is doubled; publication logic is production."""
    def __init__(self, fail_after=None):
        self.release = None
        self.data = {}
        self.creates = 0
        self.fail_after = fail_after

    def assert_source(self, tag, commit):
        if tag != 'v1.0.5' or commit != 'a' * 40:
            raise ValueError('unexpected fixture source')

    def assert_increasing(self, tag):
        pass

    def find(self, tag):
        return self.release

    def create(self, tag, commit, body):
        self.creates += 1
        self.release = {'id': 1, 'draft': True, 'tag_name': tag, 'body': body}
        return self.release

    def assets(self, release):
        return [{'name': name, 'id': name, 'size': len(data)} for name, data in self.data.items()]

    def digest(self, asset):
        return hashlib.sha256(self.data[asset['id']]).hexdigest()

    def upload(self, release, path):
        if self.fail_after == len(self.data):
            raise OSError('connection interrupted')
        if path.name in self.data:
            raise AssertionError('duplicate upload')
        self.data[path.name] = path.read_bytes()

    def finalize(self, release):
        self.release['draft'] = False


if __name__ == '__main__':
    unittest.main()
