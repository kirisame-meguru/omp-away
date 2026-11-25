"""Build and verify Away releases. Standard library only; never publishes."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TARGETS = ('linux-amd64', 'linux-arm64', 'linux-armv7', 'windows-amd64',
           'windows-arm64', 'darwin-amd64', 'darwin-arm64')
TOOLCHAINS = {'go': '1.26.0', 'bun': '1.4.4', 'uv': '0.9.5', 'python': '3.12.8',
              'gradle': '8.14.3', 'java': '17.0.17+10', 'android_sdk': '36', 'build_tools': '36.0.0'}
ANDROID_INPUTS = ('AWAY_FIREBASE_CONFIG', 'AWAY_KEYSTORE', 'AWAY_KEY_ALIAS',
                  'AWAY_STORE_PASSWORD', 'AWAY_KEY_PASSWORD', 'AWAY_SIGNING_SHA256')


def version_code(tag):
    match = re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag)
    if not match:
        raise ValueError('tag must be canonical vMAJOR.MINOR.PATCH (no prerelease suffix)')
    major, minor, patch = map(int, match.groups())
    code = major * 1000000 + minor * 1000 + patch
    if major > 2099 or minor > 999 or patch > 999 or code <= 5:
        raise ValueError('version is outside Android monotonic release range')
    return code


def expected_assets(tag):
    version_code(tag)
    return {f'away-relay-{tag}-{target}.' + ('zip' if target.startswith('windows') else 'tar.gz')
            for target in TARGETS} | {f'away-{tag}.apk', f'omp-away-plugin-{tag}.zip',
                                      'INSTALL.md', 'release.json', 'SHA256SUMS'}


def safe_name(name):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name) or name in ('.', '..'):
        raise ValueError('unsafe asset name')
    return name


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def parse_checksums(text):
    result = {}
    for line in text.splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)', line)
        if not match or match[2] in result:
            raise ValueError('invalid or duplicate checksum entry')
        result[safe_name(match[2])] = match[1]
    return result


def file_set(directory):
    files = set()
    for path in directory.iterdir():
        if path.is_symlink() or not path.is_file():
            raise ValueError('asset set contains a symlink or non-file')
        files.add(safe_name(path.name))
    return files


def seal(directory, tag, commit, epoch):
    expected = expected_assets(tag)
    if file_set(directory) != expected - {'release.json', 'SHA256SUMS'}:
        raise ValueError('incomplete or unexpected asset set; use a fresh output directory')
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('release requires a full source commit')
    manifest = {'schema': 1, 'tag': tag, 'commit': commit, 'sourceEpoch': epoch,
                'androidVersionCode': version_code(tag), 'toolchains': TOOLCHAINS,
                'relayTargets': list(TARGETS), 'coverage': 'cross-compiled; see INSTALL.md',
                'assets': sorted(expected)}
    (directory / 'release.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n', encoding='utf-8', newline='\n')
    sums = ''.join(f'{sha256(directory / name)}  {name}\n' for name in sorted(expected - {'SHA256SUMS'}))
    (directory / 'SHA256SUMS').write_text(sums, encoding='ascii', newline='\n')


def verify(directory):
    directory = Path(directory)
    if (directory / 'release.json').is_symlink() or (directory / 'SHA256SUMS').is_symlink():
        raise ValueError('manifest must be a regular file')
    manifest = json.loads((directory / 'release.json').read_text(encoding='utf-8'))
    expected = expected_assets(manifest['tag'])
    if (manifest.get('schema') != 1 or manifest.get('assets') != sorted(expected)
            or manifest.get('androidVersionCode') != version_code(manifest['tag'])
            or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', ''))
            or file_set(directory) != expected):
        raise ValueError('invalid release manifest or asset set')
    sums = parse_checksums((directory / 'SHA256SUMS').read_text(encoding='ascii'))
    if set(sums) != expected - {'SHA256SUMS'}:
        raise ValueError('checksum asset set mismatch')
    for name, digest in sums.items():
        if sha256(directory / name) != digest:
            raise ValueError('checksum mismatch: ' + name)
    return manifest


def archive(destination, root, names, epoch):
    """Only explicit files; no directory traversal, symlinks or host timestamps."""
    entries = []
    for name in sorted(names):
        p = PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:
            raise ValueError('unsafe archive member')
        path = root / name
        if path.is_symlink() or not path.is_file() or root.resolve() not in path.resolve().parents:
            raise ValueError('archive member must be an in-tree regular file')
        entries.append((name, path))
    if destination.suffix == '.zip':
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for name, path in entries:
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, path.read_bytes())
    else:
        with destination.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as tar:
                for name, path in entries:
                    info = tarfile.TarInfo(name)
                    info.size = path.stat().st_size
                    info.mtime = epoch
                    info.mode = 0o755 if name == 'away-relay' else 0o644
                    with path.open('rb') as stream:
                        tar.addfile(info, stream)


def command(args, cwd=None, env=None, capture=False):
    # Never print commands: Gradle/environment may carry protected configuration.
    result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None, text=capture)
    return result.stdout.strip() if capture else None


def executable(name):
    path = shutil.which(name)
    if not path:
        raise ValueError('required tool is missing: ' + name)
    return path


def check_toolchains():
    checks = [('go', ['version'], r'go version go1\.26\.0 '),
              ('bun', ['--version'], r'^1\.4\.4$'), ('uv', ['--version'], r'^uv 0\.9\.5(?: |$)'),
              ('gradle', ['--version'], r'Gradle 8\.14\.3\b'),
              ('java', ['-version'], r'17\.0\.17\+10')]
    for name, args, pattern in checks:
        if not re.search(pattern, command([executable(name), *args], capture=True)):
            raise ValueError('incorrect pinned toolchain: ' + name)
    if command([executable('python'), '--version'], capture=True) != 'Python 3.12.8':
        raise ValueError('Python 3.12.8 is required for release builds')
    sdk = Path(os.environ.get('ANDROID_HOME', ''))
    if not (sdk / 'platforms/android-36/android.jar').is_file():
        raise ValueError('ANDROID_HOME must contain platform android-36')
    if not (sdk / 'build-tools/36.0.0/source.properties').is_file():
        raise ValueError('Android build-tools 36.0.0 is required')


def android_inputs(env):
    for name in ANDROID_INPUTS:
        if not env.get(name):
            raise ValueError('missing protected release input: ' + name)
    config = Path(env['AWAY_FIREBASE_CONFIG'])
    key = Path(env['AWAY_KEYSTORE'])
    if not config.is_file() or not key.is_file():
        raise ValueError('Firebase client config and keystore must be existing protected files')
    data = json.loads(config.read_text(encoding='utf-8'))
    if ('private_key' in data or data.get('type') == 'service_account'
            or not data.get('project_info', {}).get('project_id')
            or not any(c.get('client_info', {}).get('android_client_info', {}).get('package_name') == 'ru.eleven.ompaway'
                       for c in data.get('client', []))):
        raise ValueError('Firebase configuration must be an Android client config, never a service account')
    if not re.fullmatch(r'[a-fA-F0-9]{64}', env['AWAY_SIGNING_SHA256']):
        raise ValueError('AWAY_SIGNING_SHA256 must be the pinned 64-hex signing certificate fingerprint')
    return config.resolve(), key.resolve()


def tracked_copy(component, destination):
    names = command(['git', 'ls-files', '-z', '--', component], cwd=ROOT, capture=True).split('\0')
    for name in filter(None, names):
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            raise ValueError('tracked source must be a regular file')
        relative = Path(name).relative_to(component)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


def build_relay(output, tag, commit, epoch):
    for target in TARGETS:
        goos, arch = target.split('-')
        with tempfile.TemporaryDirectory(prefix='away-relay-') as tmp:
            stage = Path(tmp)
            binary = 'away-relay.exe' if goos == 'windows' else 'away-relay'
            env = {**os.environ, 'GOOS': goos, 'GOARCH': 'arm' if arch == 'armv7' else arch,
                   'CGO_ENABLED': '0', 'GOTOOLCHAIN': 'local', 'GOFLAGS': '', 'GOWORK': 'off'}
            if arch == 'armv7':
                env['GOARM'] = '7'
            else:
                env.pop('GOARM', None)
            flags = f'-s -w -X main.version={tag} -X main.commit={commit} -X main.buildEpoch={epoch}'
            command(['go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags', flags,
                     '-o', stage / binary, './cmd/away-relay'], cwd=ROOT / 'relay', env=env)
            shutil.copyfile(ROOT / 'docs/releases/INSTALL.md', stage / 'INSTALL.md')
            suffix = 'zip' if goos == 'windows' else 'tar.gz'
            names = [binary, 'INSTALL.md']
            for template in ('away-relay.service', 'away-relay.nginx.conf'):
                shutil.copyfile(ROOT / 'relay/deploy' / template, stage / template)
                names.append(template)
            archive(output / f'away-relay-{tag}-{target}.{suffix}', stage, names, epoch)


def build_plugin(output, tag, epoch):
    with tempfile.TemporaryDirectory(prefix='away-plugin-') as tmp:
        stage = Path(tmp)
        plugin = stage / 'plugin'
        tracked_copy('plugin', plugin)
        # Build the existing pinned SDK in a disposable source copy, never mutate plugin/.
        command(['bun', 'install', '--frozen-lockfile'], cwd=plugin)
        command(['bun', 'media/build-sdk.ts'], cwd=plugin)
        for name in ('src/index.ts', 'src/media/live-sdk.generated.mjs', 'tunnel/uv.lock', 'media/uv.lock'):
            if not (plugin / name).is_file():
                raise ValueError('plugin package is incomplete: ' + name)
        shutil.copyfile(ROOT / 'tools/release/install_plugin.py', stage / 'install.py')
        shutil.copyfile(ROOT / 'docs/releases/INSTALL.md', stage / 'INSTALL.md')
        # Explicit distribution roots exclude node_modules, venvs, tests and machine config.
        names = ['install.py', 'INSTALL.md', 'plugin/package.json', 'plugin/bun.lock']
        for sub in ('src', 'prompts', 'tunnel/omp_away_tunnel'):
            names.extend(p.relative_to(stage).as_posix() for p in (plugin / sub).rglob('*')
                         if p.is_file() and '__pycache__' not in p.parts)
        for sub in ('tunnel', 'media'):
            names.extend('plugin/' + sub + '/' + name for name in ('pyproject.toml', 'uv.lock'))
        names.extend(('plugin/media/peer.py', 'plugin/media/opening.md'))
        archive(output / f'omp-away-plugin-{tag}.zip', stage, names, epoch)


def build_android(output, tag, inputs):
    config, key = inputs
    with tempfile.TemporaryDirectory(prefix='away-android-') as tmp:
        stage = Path(tmp)
        tracked_copy('android', stage)
        shutil.copyfile(config, stage / 'app/google-services.json')
        env = {**os.environ, 'AWAY_RELEASE_TAG': tag, 'AWAY_KEYSTORE': str(key)}
        # No daemon keeps password environment alive after this build.
        command([executable('gradle'), '--no-daemon', '--console=plain', '-p', stage, ':app:assembleRelease'], env=env)
        apk = stage / 'app/build/outputs/apk/release/app-release.apk'
        signer = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0' / ('apksigner.bat' if os.name == 'nt' else 'apksigner')
        result = command([signer, 'verify', '--verbose', '--print-certs', apk], capture=True)
        found = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)', result)
        if [s.lower() for s in found] != [os.environ['AWAY_SIGNING_SHA256'].lower()]:
            raise ValueError('APK signing identity differs from protected expected certificate')
        with zipfile.ZipFile(apk) as z:
            for info in z.infolist():
                if info.filename.lower().endswith(('.jks', '.keystore', '.p12', '.pem')):
                    raise ValueError('private key material must not be packaged')
                data = z.read(info)
                if b'-----BEGIN PRIVATE KEY-----' in data or b'"type": "service_account"' in data:
                    raise ValueError('service account material must not be packaged')
        shutil.copyfile(apk, output / f'away-{tag}.apk')


def build(output, tag):
    version_code(tag)
    inputs = android_inputs(os.environ)  # Fail before downloading or compiling anything.
    check_toolchains()
    commit = command(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture=True)
    tagged = command(['git', 'rev-parse', f'refs/tags/{tag}^{{commit}}'], cwd=ROOT, capture=True)
    if commit != tagged or command(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT, capture=True):
        raise ValueError('build requires the clean exact tagged commit')
    epoch = int(command(['git', 'show', '-s', '--format=%ct', 'HEAD'], cwd=ROOT, capture=True))
    output.mkdir(parents=True, exist_ok=False)
    build_relay(output, tag, commit, epoch)
    build_plugin(output, tag, epoch)
    build_android(output, tag, inputs)
    shutil.copyfile(ROOT / 'docs/releases/INSTALL.md', output / 'INSTALL.md')
    seal(output, tag, commit, epoch)
    verify(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    b = sub.add_parser('build')
    b.add_argument('--tag', required=True)
    b.add_argument('--out', type=Path, required=True)
    v = sub.add_parser('verify')
    v.add_argument('directory', type=Path)
    sub.add_parser('check-tools')
    args = parser.parse_args()
    if args.action == 'build':
        build(args.out.resolve(), args.tag)
    elif args.action == 'verify':
        verify(args.directory)
    else:
        check_toolchains()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError) as exc:
        # Do not dump subprocess/environment/config contents into CI logs.
        raise SystemExit(str(exc) if isinstance(exc, ValueError) else 'release failed; check protected inputs and toolchain') from None
