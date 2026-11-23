"""Isolated subprocess fixture: trust only this test's additional local CA."""
import os
import ssl
import sys
from pathlib import Path

certificate = sys.argv[1]
mode = sys.argv[2:]
original_context = ssl.create_default_context


def trusted_context(*args, **kwargs):
    context = original_context(*args, **kwargs)
    context.load_verify_locations(cafile=certificate)
    return context


# Must precede aiohttp's import-time creation of its verified connector context.
ssl.create_default_context = trusted_context
from omp_away_tunnel import broker
from omp_away_tunnel.service import main

original_spawn = broker.subprocess.Popen


def spawn(args, **kwargs):
    if args == [sys.executable, '-I', '-m', 'omp_away_tunnel', '--broker']:
        args = [sys.executable, '-I', __file__, certificate, '--broker']
    return original_spawn(args, **kwargs)


broker.subprocess.Popen = spawn
if mode == ['--broker']:
    with (Path(certificate).parent / 'broker-pids').open('a') as file:
        file.write(str(os.getpid()) + '\n')
sys.argv = ['omp_away_tunnel', *mode]
main()
