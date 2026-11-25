"""Explicit-host draft/upload/verify/finalize publication; never replace assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

from release import safe_name, sha256, verify, version_code


def https_url(value, origin_only=False):
    if not value or any(ord(c) < 33 for c in value) or '\\' in value:
        raise ValueError('unsafe host URL')
    url = urllib.parse.urlsplit(value)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.query or url.fragment or '%' in url.netloc
            or (origin_only and url.path not in ('', '/'))):
        raise ValueError('host URLs must be credential-free HTTPS')
    try:
        url.port
    except ValueError:
        raise ValueError('invalid host port') from None
    return value.rstrip('/')


def origin(value):
    url = urllib.parse.urlsplit(value)
    return f'{url.scheme}://{url.netloc}'


class HostConfig:
    def __init__(self, host, server, api, repository, upload_origin):
        if host not in ('forgejo', 'github'):
            raise ValueError('AWAY_RELEASE_HOST must be forgejo or github')
        self.host = host
        self.server = https_url(server, True)
        self.api = https_url(api)
        self.upload_origin = https_url(upload_origin, True)
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or any(x in ('.', '..') for x in repository.split('/')):
            raise ValueError('repository must be an explicit owner/name')
        if host == 'forgejo' and (self.api != self.server + '/api/v1' or self.upload_origin != self.server):
            raise ValueError('Forgejo API and uploads must belong to the configured server')
        if host == 'github':
            expected = ('https://api.github.com', 'https://uploads.github.com') if self.server == 'https://github.com' else (self.server + '/api/v3', self.server)
            if (self.api, self.upload_origin) != expected:
                raise ValueError('GitHub API/upload origins must match the explicitly configured server')
        self.repository = repository
        self.repo_api = self.api + '/repos/' + repository

    @classmethod
    def environment(cls):
        keys = ('AWAY_RELEASE_HOST', 'AWAY_SERVER_URL', 'AWAY_API_URL', 'AWAY_REPOSITORY', 'AWAY_UPLOAD_ORIGIN')
        if any(not os.environ.get(key) for key in keys):
            raise ValueError('explicit release host/API/repository/upload configuration is required')
        return cls(*(os.environ[key] for key in keys))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HostAPI:
    def __init__(self, config, token):
        if not token or '\r' in token or '\n' in token:
            raise ValueError('AWAY_RELEASE_TOKEN is required')
        self.config = config
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, url, data=None, content_type='application/json', binary=False):
        # URLs come from configured origins and locally constructed API paths.
        if origin(url) not in {origin(self.config.api), self.config.upload_origin, self.config.server}:
            raise ValueError('refusing to send a token outside configured release origins')
        headers = {'Authorization': ('token ' if self.config.host == 'forgejo' else 'Bearer ') + self.token,
                   'Accept': 'application/octet-stream' if binary else 'application/json',
                   'Content-Type': content_type, 'User-Agent': 'away-release/1'}
        if self.config.host == 'github':
            headers['X-GitHub-Api-Version'] = '2022-11-28'
        try:
            return self.opener.open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=120)
        except urllib.error.HTTPError as exc:
            # GitHub private asset downloads may redirect to short-lived signed CDN URLs.
            # Never forward the authorization header there; permit only its fixed CDN host.
            if binary and self.config.host == 'github' and exc.code in (301, 302, 303, 307, 308):
                destination = exc.headers.get('Location', '')
                parsed = urllib.parse.urlsplit(destination)
                if (parsed.scheme == 'https' and parsed.hostname == 'release-assets.githubusercontent.com'
                        and not parsed.username and not parsed.password and not parsed.fragment
                        and '\\' not in destination and not any(ord(c) < 33 for c in destination)):
                    return self.opener.open(urllib.request.Request(destination, headers={'Accept': 'application/octet-stream'}), timeout=120)
            raise

    def json(self, method, path, data=None):
        payload = json.dumps(data).encode() if data is not None else None
        with self.request(method, self.config.repo_api + path, payload) as response:
            return json.load(response)

    def pages(self, path):
        page = 1
        while True:
            items = self.json('GET', f'{path}?page={page}&limit=50&per_page=50')
            if not isinstance(items, list):
                raise ValueError('unexpected release API response')
            yield from items
            if not items:
                break
            page += 1

    def assert_source(self, tag, commit):
        if self.config.host == 'forgejo':
            actual = self.json('GET', '/tags/' + urllib.parse.quote(tag))['commit']['sha']
        else:
            obj = self.json('GET', '/git/ref/tags/' + urllib.parse.quote(tag))['object']
            for _ in range(8):
                if obj['type'] == 'commit':
                    break
                if obj['type'] != 'tag' or not re.fullmatch(r'[a-f0-9]{40}', obj['sha']):
                    raise ValueError('invalid annotated source tag')
                obj = self.json('GET', '/git/tags/' + obj['sha'])['object']
            if obj['type'] != 'commit':
                raise ValueError('source tag nesting limit exceeded')
            actual = obj['sha']
        if actual != commit:
            raise ValueError('remote tag differs from the built source commit')

    def assert_increasing(self, tag):
        code = version_code(tag)
        for release in self.pages('/releases'):
            if release.get('draft') or release['tag_name'] == tag:
                continue
            try:
                previous = version_code(release['tag_name'])
            except ValueError:
                continue  # Legacy non-policy tags cannot encode this Android version scheme.
            if previous >= code:
                raise ValueError('Android releases must have increasing versionCode')

    def find(self, tag):
        # Listing includes drafts; tag lookup alone can miss an existing GitHub draft.
        matches = [release for release in self.pages('/releases') if release['tag_name'] == tag]
        if len(matches) > 1:
            raise ValueError('duplicate releases already exist; operator recovery required')
        return matches[0] if matches else None

    def create(self, tag, commit, body):
        version_code(tag)
        return self.json('POST', '/releases', {'tag_name': tag, 'target_commitish': commit,
                         'name': tag, 'body': body, 'draft': True, 'prerelease': '-beta.' in tag})

    @staticmethod
    def identifier(value):
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError('invalid release API identifier')
        return str(value)

    def assets(self, release):
        path = '/releases/' + self.identifier(release['id']) + '/assets'
        if self.config.host == 'github':
            return list(self.pages(path))
        # Forgejo v15 returns the entire attachment list and ignores pagination.
        # Bind each UUID to its numeric ID through the release-scoped detail API.
        assets = self.json('GET', path)
        if not isinstance(assets, list):
            raise ValueError('unexpected Forgejo attachment list')
        tag = release['tag_name']
        version_code(tag)
        seen = set()
        verified = []
        fields = ('id', 'uuid', 'name', 'size', 'type')
        for asset in assets:
            aid = self.identifier(asset['id'])
            if aid in seen:
                raise ValueError('duplicate Forgejo attachment ID')
            seen.add(aid)
            detail = self.json('GET', path + '/' + aid)
            if any(field not in asset or detail.get(field) != asset[field] for field in fields):
                raise ValueError('Forgejo attachment ID/UUID metadata mismatch')
            canonical = self.forgejo_download_url(detail)
            # List responses decorate the same attachment with a release URL;
            # singular responses retain /attachments/<uuid>. Validate both
            # identities without requiring these different URL strings to match.
            named = (self.config.server + '/' + self.config.repository + '/releases/download/'
                     + urllib.parse.quote(tag, safe='') + '/'
                     + urllib.parse.quote(safe_name(asset['name']), safe=''))
            if asset.get('browser_download_url') not in (canonical, named):
                raise ValueError('unsafe Forgejo listed asset download URL')
            verified.append(detail)
        return verified

    def forgejo_download_url(self, asset):
        self.identifier(asset['id'])
        uuid = asset.get('uuid', '')
        if (not isinstance(uuid, str)
                or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', uuid)
                or asset.get('type') != 'attachment'):
            raise ValueError('invalid Forgejo attachment identity')
        expected = self.config.server + '/attachments/' + uuid
        # Exact equality excludes credentials, other origins, queries/fragments,
        # encoded traversal and redirects. External attachments are unsupported.
        if asset.get('browser_download_url') != expected:
            raise ValueError('unsafe Forgejo asset download URL')
        return expected

    def digest(self, asset):
        identifier = self.identifier(asset['id'])
        if self.config.host == 'github':
            url = self.config.repo_api + '/releases/assets/' + identifier
        else:
            # Metadata endpoints return JSON; only this exact UUID URL carries bytes.
            url = self.forgejo_download_url(asset)
        digest = hashlib.sha256()
        total = 0
        with self.request('GET', url, binary=True) as response:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > asset['size']:
                    raise ValueError('remote asset length mismatch')
                digest.update(chunk)
        if total != asset['size']:
            raise ValueError('remote asset length mismatch')
        return digest.hexdigest()

    def upload(self, release, path):
        rid = self.identifier(release['id'])
        payload = path.read_bytes()
        if self.config.host == 'forgejo':
            boundary = 'away-' + hashlib.sha256(payload).hexdigest()
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="{path.name}"\r\n'
                    'Content-Type: application/octet-stream\r\n\r\n').encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
            url = self.config.repo_api + '/releases/' + rid + '/assets?name=' + urllib.parse.quote(path.name)
            kind = 'multipart/form-data; boundary=' + boundary
        else:
            url = release['upload_url'].split('{', 1)[0]
            if origin(url) != self.config.upload_origin or urllib.parse.urlsplit(url).path != '/repos/' + self.config.repository + '/releases/' + rid + '/assets':
                raise ValueError('unexpected GitHub upload URL')
            url += '?name=' + urllib.parse.quote(path.name)
            body, kind = payload, 'application/octet-stream'
        with self.request('POST', url, body, kind) as response:
            json.load(response)

    def finalize(self, release):
        result = self.json('PATCH', '/releases/' + self.identifier(release['id']), {'draft': False})
        if result.get('draft') is not False:
            raise ValueError('host did not finalize release')


def publish(directory, host, finalize=False):
    manifest = verify(directory)
    host.assert_source(manifest['tag'], manifest['commit'])
    expected = {name: sha256(directory / name) for name in manifest['assets']}
    # Binding to the exact manifest also prevents recovering a draft from another commit.
    body = (f"Away {manifest['tag']}\n\nSource: {manifest['commit']}\n"
            f"Manifest SHA-256: {expected['release.json']}\n\n"
            'Download INSTALL.md and SHA256SUMS. Only the complete verified asset set is finalized.')
    release = host.find(manifest['tag'])
    if release is None:
        host.assert_increasing(manifest['tag'])
        release = host.create(manifest['tag'], manifest['commit'], body)
    if (release.get('tag_name') != manifest['tag'] or release.get('body') != body
            or bool(release.get('prerelease')) != ('-beta.' in manifest['tag'])):
        raise ValueError('existing release metadata differs; refusing replacement')

    def check_remote(complete):
        assets = host.assets(release)
        names = [asset['name'] for asset in assets]
        if len(names) != len(set(names)) or not set(names) <= set(expected):
            raise ValueError('duplicate or unexpected remote asset')
        if complete and set(names) != set(expected):
            raise ValueError('remote release asset set is incomplete')
        for asset in assets:
            name = asset['name']
            if asset['size'] != (directory / name).stat().st_size or host.digest(asset) != expected[name]:
                raise ValueError('remote asset differs; refusing replacement: ' + name)
        return set(names)

    present = check_remote(complete=not release['draft'])
    if not release['draft']:
        return  # Immutable, already complete. Do not PATCH an existing published release.
    for name in sorted(set(expected) - present):
        host.upload(release, directory / name)
    check_remote(complete=True)  # Read actual bytes, not server-provided checksum claims.
    if finalize:
        host.assert_source(manifest['tag'], manifest['commit'])
        host.assert_increasing(manifest['tag'])
        host.finalize(release)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--finalize', action='store_true', help='publish only after verifying every remote byte')
    args = parser.parse_args()
    publish(args.directory, HostAPI(HostConfig.environment(), os.environ.get('AWAY_RELEASE_TOKEN')), args.finalize)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        raise SystemExit(str(exc) if isinstance(exc, ValueError) else 'publication failed; draft retained for recovery') from None
