"""CI-only protected input staging; shared release.py performs the build."""
import argparse
import base64
import binascii
import json
import os
from pathlib import Path
import subprocess
import tempfile


def stage_secret(value, path):
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('protected file secret must be valid base64') from None
    if not data:
        raise ValueError('protected file secret is missing')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    tool_env = json.loads(args.environment.read_text(encoding='utf-8'))
    if set(tool_env) != {'PATH', 'ANDROID_HOME', 'JAVA_HOME', 'GOTOOLCHAIN'}:
        raise ValueError('invalid bootstrap environment')
    env = {**os.environ, **tool_env}
    with tempfile.TemporaryDirectory(prefix='away-signing-') as tmp:
        root = Path(tmp)
        for secret, variable, name in (('AWAY_FIREBASE_CONFIG_B64', 'AWAY_FIREBASE_CONFIG', 'client.json'),
                                        ('AWAY_KEYSTORE_B64', 'AWAY_KEYSTORE', 'release.jks')):
            stage_secret(env.pop(secret, ''), root / name)
            env[variable] = str(root / name)
        # Build subprocesses need neither checkout nor publication authority.
        for name in ('AWAY_CHECKOUT_TOKEN', 'AWAY_RELEASE_TOKEN', 'GITHUB_TOKEN', 'FORGEJO_TOKEN'):
            env.pop(name, None)
        subprocess.run(['python', str(Path(__file__).with_name('release.py')), 'build',
                        '--tag', args.tag, '--out', str(args.out)], env=env, check=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError):
        raise SystemExit('CI release build failed; protected temporary files removed') from None
