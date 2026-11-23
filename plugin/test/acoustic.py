"""Run synthetic native Ask dialogues through the dev phone and physical speakers/mic.
Requires pywinpty, sounddevice, soundfile and numpy; never installs or clears the app.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.request
from collections import deque

import numpy as np
import sounddevice as sd
import soundfile as sf
from winpty import PtyProcess

ROOT = Path(__file__).resolve().parent.parent
ADB = Path(os.environ['LOCALAPPDATA']) / 'Android/Sdk/platform-tools/adb.exe'
SERIAL = 'e497de61'
MIC, SPEAKER, RATE = 21, 16, 48000


def adb(*args):
    return subprocess.run([str(ADB), '-s', SERIAL, *args], capture_output=True, text=True, timeout=15, check=True)


def monitor(stop=False):
    request = urllib.request.Request('http://127.0.0.1:19584/' + ('stop' if stop else ''), method='POST' if stop else 'GET')
    with urllib.request.urlopen(request, timeout=1) as response:
        return json.load(response)


def synthesize(scenarios, directory):
    phrases = list(dict.fromkeys(step['say'] for scenario in scenarios for step in scenario['steps']))
    manifest = directory / 'speech.json'
    entries = [{'text': text, 'file': str(directory / f'phrase-{i}.wav')} for i, text in enumerate(phrases)]
    manifest.write_text(json.dumps(entries), encoding='utf-8')
    script = "Add-Type -AssemblyName System.Speech; $voice=[System.Speech.Synthesis.SpeechSynthesizer]::new(); "
    script += "$items=Get-Content -Raw -LiteralPath '" + str(manifest).replace("'", "''") + "' | ConvertFrom-Json; "
    script += "foreach($item in $items){$voice.SetOutputToWaveFile($item.file);$voice.Speak($item.text)};$voice.Dispose()"
    subprocess.run(['pwsh', '-NoProfile', '-Command', script], capture_output=True, text=True, timeout=60, check=True)
    audio = {}
    for entry in entries:
        data, rate = sf.read(entry['file'], dtype='float32')
        if data.ndim > 1:
            data = data.mean(axis=1)
        positions = np.arange(round(len(data) * RATE / rate)) * rate / RATE
        data = np.interp(positions, np.arange(len(data)), data).astype('float32')
        audio[entry['text']] = np.repeat((data * .6)[:, None], 2, axis=1)
    return audio


def run(scenario, directory, audio):
    directory.mkdir()
    trace = directory / 'voice.log'
    config = directory / 'config.yml'
    config.write_text('collab:\n  relayUrl: ws://127.0.0.1:19585\n  autoStart: control\nask:\n  timeout: 0\nstartup:\n  checkUpdate: false\n', encoding='utf-8')
    child_env = {key: value for key, value in os.environ.items() if key not in (
        'OMP_AWAY_URL', 'OMP_AWAY_TOKEN_FILE', 'OMP_AWAY_STATE_DIR', 'OMP_AWAY_TUNNEL_PYTHON')}
    child_env['OMP_AWAY_VOICE_TRACE'] = str(trace)
    command = f"omp --no-session --no-extensions --config '{config}' -e '{ROOT / 'src/index.ts'}' --tools ask -e '{ROOT / 'test/fixtures/acoustic.ts'}'"
    process = PtyProcess.spawn(['pwsh', '-NoProfile', '-Command', command], cwd=str(ROOT), env=child_env, dimensions=(40, 140))
    terminal = deque(maxlen=30)
    def drain():
        try:
            while process.isalive():
                terminal.append(process.read(4096))
        except (EOFError, OSError):
            pass
    threading.Thread(target=drain, daemon=True).start()
    last_loud = [0.0]
    peak = [0.0]
    def meter(data, frames, timing, status):
        rms = float(np.sqrt(np.mean(data * data)))
        peak[0] = max(peak[0], rms)
        if rms >= .006:
            last_loud[0] = time.time()
    instrument = None
    played = []
    state = {}
    failure = None
    instrumentation = ''
    try:
        deadline = time.monotonic() + 30
        while 'Away: local guest ready' not in ''.join(terminal):
            if not process.isalive() or time.monotonic() > deadline:
                raise RuntimeError('native-host-not-ready')
            time.sleep(.1)
        process.write('/acousticprobe\r')
        deadline = time.monotonic() + 30
        while not Path(str(trace) + '.ready').exists():
            if not process.isalive() or time.monotonic() > deadline:
                raise RuntimeError('audio-bridge-not-ready')
            time.sleep(.1)
        adb('reverse', 'tcp:19583', 'tcp:19583')
        with sd.InputStream(device=MIC, samplerate=192000, channels=2, blocksize=1920, callback=meter):
            instrument = subprocess.Popen([str(ADB), '-s', SERIAL, 'shell', 'am', 'instrument', '-w', '-e', 'class',
                'ru.eleven.ompaway.CallAudioTest#isolatedDesktopSpeechReachesHardwareWithMicrophoneRunning',
                '-e', 'desktopAudioPort', '19583', '-e', 'speakerMode', 'on', '-e', 'captions', 'on',
                'ru.eleven.ompaway.test/androidx.test.runner.AndroidJUnitRunner'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            previous_message = 0
            for step in scenario['steps']:
                deadline = time.monotonic() + 55
                pause_until = time.monotonic() + step.get('seconds', 0)
                while True:
                    state = monitor()
                    if state['submitted'] or state['ended'] or state['errors']:
                        raise RuntimeError('call-ended-before-dialogue-finished')
                    now = time.time()
                    quiet = now - state['lastVoicedAt'] / 1000 >= .8 and now - last_loud[0] >= .8
                    heard = last_loud[0] > state['lastVoicedAt'] / 1000 - 1
                    if step['after'] == 'pause':
                        ready = time.monotonic() >= pause_until
                    else:
                        ready = state['messages'] > previous_message and state['lastVoicedAt'] >= state['messageAt']
                        ready = ready and ('submit' in state['assistantWords'] if step['after'] == 'readback' else state['assistantWordCount'] >= 3)
                        if step['after'] == 'opening':
                            words = set(state['assistantWords'])
                            ready = ready and {'tea', 'coffee'} <= words and bool({'other', 'own'} & words)
                    if ready and quiet and heard:
                        break
                    if time.monotonic() > deadline or instrument.poll() is not None:
                        raise RuntimeError('expected-spoken-turn-not-heard')
                    time.sleep(.05)
                previous_message = state['messages']
                played.append({'say': step['say'], 'at': round(time.time() * 1000)})
                sd.play(audio[step['say']], RATE, device=SPEAKER, blocking=True)
            deadline = time.monotonic() + 35
            while not Path(str(trace) + '.result').exists() and time.monotonic() < deadline:
                time.sleep(.1)
            if not Path(str(trace) + '.result').exists():
                raise RuntimeError('native-submission-not-completed')
    except Exception as error:
        failure = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        try:
            if Path(str(trace) + '.ready').exists() and process.isalive():
                monitor(stop=True)
        except Exception:
            pass
        if instrument is not None:
            try:
                instrumentation = instrument.communicate(timeout=12)[0]
            except subprocess.TimeoutExpired:
                adb('shell', 'am', 'force-stop', 'ru.eleven.ompaway')
                instrumentation = instrument.communicate(timeout=5)[0]
        if process.isalive():
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=10)
        subprocess.run([str(ADB), '-s', SERIAL, 'reverse', '--remove', 'tcp:19583'], capture_output=True, timeout=10)
    result = Path(str(trace) + '.result')
    if result.exists():
        state = json.loads(result.read_text())
    passed = not failure and state.get('submitted') == 1 and state.get('delivery') == 'accepted' and state.get('nativeEnded') and state.get('values') == scenario['expected'] and not state.get('errors') and 'OK (1 test)' in instrumentation
    report = {'scenario': scenario['name'], 'passed': bool(passed), 'failure': failure, 'played': played, 'state': state,
              'instrumentation': instrumentation, 'peakRms': peak[0], 'transcripts': [str(p) for p in Path(str(trace) + '.state/calls').glob('*.jsonl')]}
    (directory / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scenario', nargs='*', help='Scenario names; defaults to direct')
    parser.add_argument('--all', action='store_true')
    args = parser.parse_args()
    scenarios = json.loads((ROOT / 'test/acoustic.json').read_text())
    names = args.scenario or ['direct']
    selected = scenarios if args.all else [s for s in scenarios if s['name'] in names]
    if not selected or not args.all and set(names) - {s['name'] for s in selected}:
        parser.error('Unknown scenario')
    assert 'elf' in sd.query_devices(MIC)['name'].lower(), 'Authorized microphone changed'
    assert 'thunderbolt' in sd.query_devices(SPEAKER)['name'].lower(), 'Authorized speakers changed'
    assert adb('get-state').stdout.strip() == 'device'
    directory = Path(tempfile.mkdtemp(prefix='away-dialogues-'))
    audio = synthesize(selected, directory)
    success = True
    for scenario in selected:
        report = run(scenario, directory / scenario['name'], audio)
        success = success and report['passed']
        print(json.dumps({'scenario': scenario['name'], 'passed': report['passed'], 'failure': report['failure'], 'report': str(directory / scenario['name'] / 'result.json')}), flush=True)
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    main()
