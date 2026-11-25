"""Inject bounded synthetic speech into an explicitly selected rooted Away process.

Requires a matching Frida client/server and an authenticated, loopback-only ADB
forward. Does not root the device, install software, change pairing, or end calls.
Close the test call before stopping this controller: detach restores microphone
reads. Connection credentials, controls, recordings and reports belong outside Git.
"""
import argparse
import json
from pathlib import Path
import threading
import time
import wave

import frida


def load_pcm(filename):
    with wave.open(str(filename), 'rb') as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype()) != (1, 2, 24000, 'NONE'):
            raise ValueError('Speech must be mono PCM16 WAV at 24000 Hz')
        frames = source.getnframes()
        if not 0 < frames <= 24000 * 60:
            raise ValueError('Speech must be between one frame and 60 seconds')
        pcm = source.readframes(frames)
        if len(pcm) != frames * 2:
            raise ValueError('Truncated speech WAV')
        return pcm


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--connection', type=Path, required=True, help='Private JSON containing port, token and pid')
    parser.add_argument('--control', type=Path, required=True, help='Private JSON command file, replaced atomically by the operator')
    parser.add_argument('--out', type=Path, required=True, help='New private output directory; must not exist')
    args = parser.parse_args()
    connection = json.loads(args.connection.read_text(encoding='utf-8'))
    port, pid, token = (connection.get(key) for key in ('port', 'pid', 'token'))
    if type(port) is not int or not 1 <= port <= 65535 or type(pid) is not int or pid <= 0 or not isinstance(token, str) or not token:
        raise ValueError('Connection requires a valid forwarded port, explicit PID and authentication token')
    args.out.mkdir(mode=0o700, parents=True, exist_ok=False)
    lock = threading.Lock()
    stop = threading.Event()
    state = {'ready': False, 'closed': False, 'commands': [], 'consumed': [], 'errors': [], 'stats': {}}
    events = (args.out / 'events.jsonl').open('w', encoding='utf-8')
    playback = wave.open(str(args.out / 'playback.wav'), 'wb')
    playback.setnchannels(1)
    playback.setsampwidth(2)
    playback.setframerate(24000)

    def save():
        temporary = args.out / 'state.tmp'
        temporary.write_text(json.dumps(state), encoding='utf-8')
        temporary.replace(args.out / 'state.json')

    def message(received, data):
        with lock:
            if state['closed']:
                return
            if received.get('type') == 'error':
                state['errors'].append(received.get('description', 'instrumentation-error'))
                save()
                return
            payload = received.get('payload', {})
            kind = payload.get('kind')
            if kind == 'playback':
                if data is not None:
                    playback.writeframesraw(data)
                return
            events.write(json.dumps({'at': time.time(), **payload}) + '\n')
            events.flush()
            if kind == 'ready':
                state['ready'] = True
            elif kind == 'stats':
                state['stats'] = payload
            elif kind == 'consumed':
                state['consumed'].append(payload)
            elif kind in ('error', 'rejected'):
                state['errors'].append(payload)
            save()

    def detached(reason, _crash):
        with lock:
            if not stop.is_set() and not state['closed']:
                state['errors'].append({'kind': 'detached', 'reason': reason})
                state['ready'] = False
                save()
        stop.set()

    device = None
    session = None
    script = None
    try:
        save()
        device = frida.get_device_manager().add_remote_device(f'127.0.0.1:{port}', token=token)
        session = device.attach(pid)
        session.on('detached', detached)
        script = session.create_script(Path(__file__).with_suffix('.js').read_text(encoding='utf-8'))
        script.on('message', message)
        script.load()
        previous_mtime = None
        seen = set()
        while not stop.wait(.1):
            try:
                mtime = args.control.stat().st_mtime_ns
                if mtime == previous_mtime:
                    continue
                command = json.loads(args.control.read_text(encoding='utf-8'))
            except (FileNotFoundError, json.JSONDecodeError):
                continue
            previous_mtime = mtime
            identity = command.get('id')
            if not isinstance(identity, str) or not identity or identity in seen:
                continue
            seen.add(identity)
            if command.get('op') == 'stop':
                break
            if command.get('op') != 'queue':
                raise ValueError('Control operation must be queue or stop')
            pcm = load_pcm(Path(command['wav']))
            with lock:
                if not state['ready'] or state['errors']:
                    raise RuntimeError('Instrumentation is not healthy; close the test call')
                state['commands'].append({'id': identity, 'bytes': len(pcm)})
                save()
            script.post({'type': 'pcm', 'id': identity}, pcm)
    except Exception as error:
        with lock:
            state['errors'].append({'kind': 'controller', 'error': type(error).__name__})
        raise
    finally:
        stop.set()
        for resource, operation in ((script, 'unload'), (session, 'detach')):
            if resource is not None:
                try:
                    getattr(resource, operation)()
                except frida.InvalidOperationError:
                    pass  # Already destroyed by a process exit or transport disconnect.
                except Exception as error:
                    with lock:
                        state['errors'].append({'kind': 'cleanup', 'operation': operation, 'error': type(error).__name__})
        with lock:
            playback.close()
            events.close()
            state['closed'] = True
            state['ready'] = False
            save()
        if device is not None:
            frida.get_device_manager().remove_remote_device(f'127.0.0.1:{port}')


if __name__ == '__main__':
    main()
