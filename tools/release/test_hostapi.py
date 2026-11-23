import io
import json
from pathlib import Path
import tempfile
import unittest

from publish import HostAPI, HostConfig


class FixtureAPI(HostAPI):
    def __init__(self, host='forgejo', responses=None):
        config = (HostConfig('forgejo', 'https://forge.example.org', 'https://forge.example.org/api/v1',
                             'team/away', 'https://forge.example.org') if host == 'forgejo' else
                  HostConfig('github', 'https://github.com', 'https://api.github.com',
                             'team/away', 'https://uploads.github.com'))
        super().__init__(config, 'test-token')
        self.responses = responses or {}
        self.calls = []

    def json(self, method, path, data=None):
        return self.responses[(method, path)]

    def request(self, method, url, data=None, content_type='application/json', binary=False):
        self.calls.append((method, url, data, content_type))
        return io.BytesIO(b'{}')


class HostAPITests(unittest.TestCase):
    @staticmethod
    def forgejo_asset():
        # Forgejo v15.0.11 Attachment JSON; reserved host and synthetic identity.
        return {'id': 42, 'name': 'INSTALL.md', 'size': 2, 'download_count': 0,
                'created_at': '2026-01-01T00:00:00Z',
                'uuid': '12345678-1234-4234-8234-123456789abc', 'type': 'attachment',
                'browser_download_url': 'https://forge.example.org/attachments/12345678-1234-4234-8234-123456789abc'}

    def test_forgejo_unpaginated_assets_bind_numeric_id_and_uuid_before_download(self):
        asset = self.forgejo_asset()
        api = FixtureAPI(responses={
            ('GET', '/releases/7/assets'): [asset],
            ('GET', '/releases/7/assets/42'): dict(asset),
        })
        assets = api.assets({'id': 7})
        self.assertEqual(assets, [asset])
        self.assertEqual(api.digest(assets[0]), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
        self.assertEqual(api.calls[0][:2], ('GET', asset['browser_download_url']))

    def test_forgejo_numeric_id_lookup_must_match_listed_uuid_and_metadata(self):
        listed = self.forgejo_asset()
        for field, value in (('id', 43), ('uuid', '87654321-4321-4321-8321-abcdef123456'),
                             ('name', 'other'), ('size', 3), ('type', 'external'),
                             ('browser_download_url', 'https://forge.example.org/attachments/87654321-4321-4321-8321-abcdef123456')):
            api = FixtureAPI(responses={
                ('GET', '/releases/7/assets'): [listed],
                ('GET', '/releases/7/assets/42'): {**listed, field: value},
            })
            with self.subTest(field=field), self.assertRaises(ValueError):
                api.assets({'id': 7})
            self.assertEqual(api.calls, [])

    def test_forgejo_download_rejects_uuid_substitution_and_unsafe_urls_before_request(self):
        valid = self.forgejo_asset()
        mutations = [
            {'id': True}, {'id': 0}, {'uuid': '../outside'}, {'uuid': valid['uuid'].upper()},
            {'uuid': '87654321-4321-4321-8321-abcdef123456'}, {'type': 'external'},
            {'browser_download_url': valid['browser_download_url'] + '?token=x'},
            {'browser_download_url': valid['browser_download_url'] + '#fragment'},
            {'browser_download_url': valid['browser_download_url'].replace('https://', 'http://')},
            {'browser_download_url': valid['browser_download_url'].replace('forge.example.org', 'evil.example.org')},
            {'browser_download_url': valid['browser_download_url'].replace('https://', 'https://user:pass@')},
            {'browser_download_url': valid['browser_download_url'].replace('/attachments/', '/attachments/%2e%2e/')},
            {'browser_download_url': 'https://forge.example.org/team/away/releases/download/v1.0.5/INSTALL.md'},
        ]
        for mutation in mutations:
            api = FixtureAPI()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                api.digest({**valid, **mutation})
            self.assertEqual(api.calls, [])

    def test_forgejo_source_binding_rejects_moved_tag(self):
        api = FixtureAPI(responses={('GET', '/tags/v1.0.5'): {'commit': {'sha': 'b' * 40}}})
        with self.assertRaisesRegex(ValueError, 'tag'):
            api.assert_source('v1.0.5', 'a' * 40)
        api.assert_source('v1.0.5', 'b' * 40)

    def test_github_annotated_tag_is_peeled_to_commit(self):
        api = FixtureAPI('github', {
            ('GET', '/git/ref/tags/v1.0.5'): {'object': {'type': 'tag', 'sha': 'b' * 40}},
            ('GET', '/git/tags/' + 'b' * 40): {'object': {'type': 'commit', 'sha': 'a' * 40}},
        })
        api.assert_source('v1.0.5', 'a' * 40)
        with self.assertRaises(ValueError):
            api.assert_source('v1.0.5', 'c' * 40)

    def test_older_android_release_cannot_be_finalized_after_newer_release(self):
        api = FixtureAPI(responses={('GET', '/releases?page=1&limit=50&per_page=50'): [
            {'tag_name': 'v1.0.6', 'draft': False}],
            ('GET', '/releases?page=2&limit=50&per_page=50'): []})
        with self.assertRaisesRegex(ValueError, 'increasing'):
            api.assert_increasing('v1.0.5')
        api.assert_increasing('v1.0.7')

    def test_uploads_use_forgejo_multipart_and_github_explicit_binary_origin(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'INSTALL.md'
            path.write_bytes(b'content')
            forge = FixtureAPI()
            forge.upload({'id': 7}, path)
            method, url, body, content_type = forge.calls[0]
            self.assertEqual(method, 'POST')
            self.assertEqual(url, 'https://forge.example.org/api/v1/repos/team/away/releases/7/assets?name=INSTALL.md')
            self.assertTrue(content_type.startswith('multipart/form-data; boundary='))
            self.assertIn(b'name="attachment"; filename="INSTALL.md"', body)
            self.assertIn(b'\r\n\r\ncontent\r\n', body)
            github = FixtureAPI('github')
            github.upload({'id': 7, 'upload_url': 'https://uploads.github.com/repos/team/away/releases/7/assets{?name,label}'}, path)
            self.assertEqual(github.calls[0], ('POST', 'https://uploads.github.com/repos/team/away/releases/7/assets?name=INSTALL.md', b'content', 'application/octet-stream'))
            with self.assertRaises(ValueError):
                github.upload({'id': 7, 'upload_url': 'https://evil.example.org/repos/team/away/releases/7/assets'}, path)


if __name__ == '__main__':
    unittest.main()
