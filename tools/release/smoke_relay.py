"""Launch an actual packaged relay and check loopback health with disposable inputs."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def synthetic_environment(root, port, inherited):
    # No real credentials, account, device or FCM token is accepted by this smoke.
    env = {key: value for key, value in inherited.items()
           if key.upper() in {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR'}}
    state = root / 'state'
    state.mkdir(mode=0o700)
    adc = {'type': 'authorized_user', 'client_id': 'synthetic-smoke.example.invalid',
           'client_secret': 'synthetic-only', 'refresh_token': 'synthetic-only',
           'quota_project_id': 'away-smoke'}
    for name, content in (('synthetic-adc.json', json.dumps(adc)), ('desktop-token', secrets.token_urlsafe(32))):
        fd = os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='ascii') as stream:
            stream.write(content)
    env.update({'AWAY_LISTEN': f'127.0.0.1:{port}', 'AWAY_STATE_DIR': str(state),
                'AWAY_DESKTOP_TOKEN_FILE': str(root / 'desktop-token'),
                'GOOGLE_APPLICATION_CREDENTIALS': str(root / 'synthetic-adc.json'),
                'GOOGLE_CLOUD_PROJECT': 'away-smoke', 'HOME': str(root), 'USERPROFILE': str(root),
                # Initialization and health must not authenticate or contact Firebase.
                # Any accidentally attempted HTTP(S)/metadata call fails locally.
                'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
                'http_proxy': 'http://127.0.0.1:9', 'https_proxy': 'http://127.0.0.1:9',
                'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost',
                'GCE_METADATA_HOST': '127.0.0.1:9'})
    return env


def protect_windows_directory(root):
    # Set only a disposable directory's ACL, before any files/secrets exist.
    # Values are passed through the environment, never interpolated as PowerShell.
    script = r'''
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:AWAY_SMOKE_DIRECTORY -AclObject $acl
'''
    subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
                   env={**os.environ, 'AWAY_SMOKE_DIRECTORY': str(root)}, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def smoke(binary, timeout=20):
    binary = binary.resolve(strict=True)
    if not binary.is_file() or timeout <= 0:
        raise ValueError('provide the actual native packaged relay executable and a positive timeout')
    with tempfile.TemporaryDirectory(prefix='away-native-smoke-') as tmp:
        root = Path(tmp)
        if os.name == 'nt':
            protect_windows_directory(root)
        native = root / ('away-relay.exe' if os.name == 'nt' else 'away-relay')
        shutil.copyfile(binary, native)
        native.chmod(0o500)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        env = synthetic_environment(root, port, os.environ)
        if os.name == 'nt':
            # The state directory itself must have a protected DACL. Its files
            # inherit only the process user, SYSTEM and Administrators grants.
            protect_windows_directory(root / 'state')
        identity = {}
        if os.name != 'nt' and os.geteuid() == 0:
            import pwd
            user = pwd.getpwnam('nobody')
            if user.pw_uid == 0:
                raise ValueError('native smoke requires a non-root child identity')
            for path in [root, *root.rglob('*')]:
                os.chown(path, user.pw_uid, user.pw_gid)
            identity = {'user': user.pw_uid, 'group': user.pw_gid, 'extra_groups': []}
        process = subprocess.Popen([str(native)], cwd=root, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **identity)
        healthy = False
        try:
            deadline = time.monotonic() + timeout
            client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise ValueError('packaged relay exited before native health became ready')
                try:
                    with client.open(f'http://127.0.0.1:{port}/healthz', timeout=0.5) as response:
                        if response.status == 200 and response.read(1) == b'':
                            healthy = True
                            break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(0.05)
            if not healthy:
                raise ValueError('packaged relay native health deadline exceeded')
            time.sleep(0.1)
            if process.poll() is not None:
                raise ValueError('packaged relay exited after its health response')
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise ValueError('packaged relay did not terminate after native smoke') from None
        if os.name != 'nt' and process.returncode != 0:
            raise ValueError('packaged relay did not shut down gracefully')
    print('Native packaged relay startup, loopback /healthz and shutdown succeeded; no Firebase delivery was attempted.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--timeout', type=float, default=20)
    args = parser.parse_args()
    smoke(args.binary, args.timeout)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc) if isinstance(exc, ValueError) else 'native smoke setup failed; no real credentials are used') from None
