"""Provision a verified extracted plugin archive, then link its actual subdirectory."""
import argparse
import os
from pathlib import Path
import re
import subprocess


def isolated_environment(home, original):
    # A clean installer test must not discover the operator's provider credentials/state.
    env = {key: value for key, value in original.items()
           if key.upper() in {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR'}}
    env.update({'HOME': str(home), 'USERPROFILE': str(home), 'PI_CONFIG_DIR': '.omp',
                'PI_CODING_AGENT_DIR': str(home / '.omp/agent'),
                'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_DATA_HOME': str(home / '.local/share'),
                'XDG_STATE_HOME': str(home / '.local/state'), 'XDG_CACHE_HOME': str(home / '.cache'),
                'APPDATA': str(home / 'AppData/Roaming'), 'LOCALAPPDATA': str(home / 'AppData/Local')})
    return env


def provisioning_commands(root, omp):
    return [['bun', 'install', '--frozen-lockfile', '--production'],
            *[['uv', 'sync', '--locked', '--no-dev', '--python', '3.12.8', '--project', str(root / 'plugin' / helper)]
              for helper in ('tunnel', 'media')],
            [omp, 'install', str(root / 'plugin')]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent,
                        help='extracted archive root (contains plugin/)')
    parser.add_argument('--omp', default='omp', help='path to stock omp 19.1.0')
    parser.add_argument('--isolated-home', type=Path, help='new empty home for clean install acceptance')
    args = parser.parse_args()
    root = args.root.resolve()
    for name in ('package.json', 'bun.lock', 'src/index.ts', 'src/media/live-sdk.generated.mjs',
                 'src/media/prompts/away-call.md', 'src/prompts/translate.md',
                 'tunnel/uv.lock', 'media/uv.lock', 'media/peer.py', 'media/opening.md'):
        if not (root / 'plugin' / name).is_file():
            raise ValueError('extract the complete verified plugin archive first')
    env = os.environ.copy()
    if args.isolated_home:
        home = args.isolated_home.resolve()
        home.mkdir(parents=True, exist_ok=False)
        env = isolated_environment(home, env)
    for tool, expected in (('bun', r'^1\.4\.4$'), ('uv', r'^uv 0\.9\.5(?: |$)'),
                           (args.omp, r'\b19\.1\.0\b')):
        result = subprocess.run([tool, '--version'], env=env, check=True, text=True, capture_output=True)
        if not re.search(expected, result.stdout.strip()):
            raise ValueError('incorrect pinned installer tool: ' + Path(tool).name)
    for cmd in provisioning_commands(root, args.omp):
        subprocess.run(cmd, cwd=root / 'plugin', env=env, check=True)
    for helper, module in (('tunnel', 'omp_away_tunnel'), ('media', 'aiortc, av')):
        python = root / 'plugin' / helper / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        subprocess.run([str(python), '-I', '-c', 'import ' + module], env=env, check=True)
    subprocess.run([args.omp, 'plugin', 'doctor'], cwd=root / 'plugin', env=env, check=True)
    print('Plugin linked. Keep the extracted directory; it is the installed source, not a temporary installer.')
    print('Set OMP_AWAY_TUNNEL_PYTHON to the absolute plugin/tunnel/.venv interpreter before starting omp.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc) if isinstance(exc, ValueError) else 'plugin provisioning failed; no runtime credentials were required') from None
