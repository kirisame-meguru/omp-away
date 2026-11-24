"""Run synthetic native Ask dialogues through a disposable phone app and physical audio.
Requires pywinpty, sounddevice, soundfile and numpy; never installs or clears apps.
Set ANDROID_SERIAL and select --mic/--speaker using --list-audio.
Only ru.eleven.ompaway.integration and its instrumentation package are operated on.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
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
RATE = 48000
TARGET = 'ru.eleven.ompaway.integration'
RUNNER = TARGET + '.test/androidx.test.runner.AndroidJUnitRunner'


def adb(options, *args):
    return subprocess.run([options.adb, '-s', options.serial, *args], capture_output=True, text=True, timeout=15, check=True)


def settings(parser, options):
    options.serial = os.environ.get('ANDROID_SERIAL', '').strip()
    if not options.serial or any(char.isspace() for char in options.serial):
        parser.error('Set ANDROID_SERIAL explicitly to the authorized disposable-test device')
    options.adb = shutil.which('adb')
    if not options.adb:
        home = os.environ.get('ANDROID_HOME')
        candidate = Path(home) / 'platform-tools' / ('adb.exe' if os.name == 'nt' else 'adb') if home else None
        if not candidate or not candidate.is_file():
            parser.error('Put adb on PATH or set ANDROID_HOME')
        options.adb = str(candidate)
    if options.mic is None or options.speaker is None:
        parser.error('Select --mic and --speaker explicitly, or set OMP_AWAY_ACOUSTIC_MIC and OMP_AWAY_ACOUSTIC_SPEAKER')
    devices = sd.query_devices()
    for index, direction in ((options.mic, 'input'), (options.speaker, 'output')):
        if not 0 <= index < len(devices) or devices[index]['max_' + direction + '_channels'] < 1:
            parser.error('Selected audio index does not support the requested direction; use --list-audio')
    options.mic_channels = min(2, devices[options.mic]['max_input_channels'])
    options.speaker_channels = min(2, devices[options.speaker]['max_output_channels'])
    options.mic_rate = devices[options.mic]['default_samplerate']
    sd.check_input_settings(device=options.mic, channels=options.mic_channels, samplerate=options.mic_rate, dtype='float32')
    sd.check_output_settings(device=options.speaker, channels=options.speaker_channels, samplerate=RATE, dtype='float32')
    if adb(options, 'get-state').stdout.strip() != 'device':
        parser.error('Selected Android device is not ready')
    if not adb(options, 'shell', 'pm', 'path', TARGET).stdout.strip().startswith('package:'):
        parser.error('Install the disposable integration APK first')
    instrumentation = adb(options, 'shell', 'pm', 'list', 'instrumentation').stdout.splitlines()
    if f'instrumentation:{RUNNER} (target={TARGET})' not in [line.strip() for line in instrumentation]:
        parser.error('Install the integration test APK targeting only the disposable integration app')


def load_scenarios(path):
    with path.open(encoding='utf-8') as file:
        encoded = file.read(262145)
    if len(encoded) > 262144:
        raise ValueError('Scenario file exceeds 256 KiB')
    scenarios = json.loads(encoded)
    if not isinstance(scenarios, list) or not 1 <= len(scenarios) <= 32:
        raise ValueError('Provide between 1 and 32 synthetic scenarios')
    names = set()
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            raise ValueError('Invalid scenario')
        name = scenario.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', name) or name in names:
            raise ValueError('Scenario names must be unique safe directory names')
        names.add(name)
        for key, limit in (('form', 8192), ('prompt', 4096), ('taskContext', 8192)):
            if key in scenario and (not isinstance(scenario[key], str) or len(scenario[key]) > limit or key == 'form' and not scenario[key].strip()):
                raise ValueError('Invalid or oversize fixture form/prompt')
        scenario.setdefault('openingWords', ['tea', 'coffee'])
        scenario.setdefault('openingAny', [] if 'form' in scenario else ['other', 'own'])
        for key in ('openingWords', 'openingAny'):
            words = scenario[key]
            if not isinstance(words, list) or len(words) > 32 or key == 'openingWords' and not words or any(not isinstance(word, str) or not re.fullmatch(r'[a-z]{1,32}', word) for word in words):
                raise ValueError('Opening words must be bounded lowercase words')
        duration = scenario.setdefault('durationSeconds', 180)
        if type(duration) is not int or not 60 <= duration <= 900:
            raise ValueError('Scenario duration must be between 60 and 900 seconds')
        if type(scenario.get('bargeIn', False)) is not bool:
            raise ValueError('Barge-in opt-in must be boolean')
        expected = scenario.get('expected')
        if not isinstance(expected, dict) or not 1 <= len(expected) <= 16 or any(not isinstance(key, str) or not 1 <= len(key) <= 128 or not isinstance(value, str) or len(value) > 1024 for key, value in expected.items()):
            raise ValueError('Expected values must be a bounded synthetic string map')
        steps = scenario.get('steps')
        if not isinstance(steps, list) or not 1 <= len(steps) <= 16:
            raise ValueError('Provide between 1 and 16 acoustic steps')
        for step in steps:
            if not isinstance(step, dict) or not isinstance(step.get('say'), str) or not 1 <= len(step['say']) <= 1024 or step.get('after') not in ('opening', 'answer', 'readback', 'pause', 'during-readback'):
                raise ValueError('Invalid acoustic step')
            seconds = step.get('seconds', 0)
            if type(seconds) not in (int, float) or not 0 <= seconds <= 30:
                raise ValueError('Pause must be between 0 and 30 seconds')
            if step['after'] == 'during-readback' and (not scenario.get('bargeIn') or not .1 <= seconds <= 2):
                raise ValueError('During-readback requires opt-in and a 0.1–2 second audible offset')
            if set(step) - {'say', 'after', 'seconds', 'spokenWords'}:
                raise ValueError('Unknown acoustic step requirement')
            groups = step.get('spokenWords', [])
            if not isinstance(groups, list) or len(groups) > 8:
                raise ValueError('Spoken expectations require at most eight word groups')
            for group in groups:
                if not isinstance(group, list) or not 1 <= len(group) <= 8 or any(not isinstance(word, str) or not re.fullmatch(r"[a-z']{1,32}", word) for word in group):
                    raise ValueError('Spoken word groups must be bounded lowercase synthetic words')
        scenario['observedWords'] = sorted({word for step in steps for group in step.get('spokenWords', []) for word in group})
        if len(scenario['observedWords']) > 128:
            raise ValueError('At most 128 synthetic observation words per scenario')
    return scenarios


def monitor(stop=False):
    request = urllib.request.Request('http://127.0.0.1:19584/' + ('stop' if stop else ''), method='POST' if stop else 'GET')
    with urllib.request.urlopen(request, timeout=1) as response:
        return json.load(response)


def synthesize(scenarios, directory, channels):
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
        audio[entry['text']] = np.repeat((data * .6)[:, None], channels, axis=1)
    return audio


def response_for_step(state, after, since=0, previous_caller=None):
    responses = state.get('responses', [])
    if not responses or responses[-1]['startedAt'] < since:
        return None
    start = len(responses) - 1
    while start:
        current, previous = responses[start], responses[start - 1]
        if (previous['startedAt'] < since or current['callerTurn'] != previous['callerTurn']
                or current['readback'] or current['category'] == 'opening'):
            break
        start -= 1
    fragments = responses[start:]
    first, last = fragments[0], fragments[-1]
    if after == 'opening' and first['category'] != 'opening':
        return None
    if (previous_caller is not None and first['callerTurn'] <= previous_caller
            and state.get('lastCallerFinalAt', 0) < since):
        return None
    # Provider finals can split one spoken answer. Keep every raw observation,
    # but require its latest fragment to finish; never borrow another caller's words.
    return {
        **first, 'finalAt': last['finalAt'],
        'firstAudioAt': next((part['firstAudioAt'] for part in fragments if part['firstAudioAt']), 0),
        'lastAudioAt': max(part['lastAudioAt'] for part in fragments),
        'words': list(dict.fromkeys(word for part in fragments for word in part['words'])),
        'wordCount': sum(part['wordCount'] for part in fragments),
        'submitPrompts': sum(part['submitPrompts'] for part in fragments),
        'interrupted': any(part['interrupted'] for part in fragments),
    }


def run(scenario, directory, audio, options):
    directory.mkdir()
    trace = directory / 'voice.log'
    config = directory / 'config.yml'
    config.write_text('collab:\n  relayUrl: ws://127.0.0.1:19585\n  autoStart: control\nask:\n  timeout: 0\nstartup:\n  checkUpdate: false\n', encoding='utf-8')
    child_env = {key: value for key, value in os.environ.items() if key not in (
        'OMP_AWAY_URL', 'OMP_AWAY_TOKEN_FILE', 'OMP_AWAY_STATE_DIR', 'OMP_AWAY_TUNNEL_PYTHON')}
    child_env['OMP_AWAY_VOICE_TRACE'] = str(trace)
    child_env['OMP_AWAY_ACOUSTIC_FIXTURE'] = json.dumps({key: scenario[key] for key in ('form', 'prompt', 'taskContext', 'openingWords', 'openingAny', 'observedWords', 'durationSeconds') if key in scenario}, ensure_ascii=False)
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    command = f"omp --no-session --no-extensions --config {quote(config)} -e {quote(ROOT / 'src/index.ts')} --tools ask -e {quote(ROOT / 'test/fixtures/acoustic.ts')}"
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
    reverse_owned = False
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
        # Never replace or later remove a reverse mapping belonging to another run.
        adb(options, 'reverse', '--no-rebind', 'tcp:19583', 'tcp:19583')
        reverse_owned = True
        with sd.InputStream(device=options.mic, samplerate=options.mic_rate, channels=options.mic_channels, dtype='float32', callback=meter):
            instrument = subprocess.Popen([options.adb, '-s', options.serial, 'shell', 'am', 'instrument', '-w', '-e', 'class',
                'ru.eleven.ompaway.CallAudioTest#isolatedDesktopSpeechReachesHardwareWithMicrophoneRunning',
                '-e', 'desktopAudioPort', '19583', '-e', 'speakerMode', 'on', '-e', 'captions', 'on',
                RUNNER], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            previous_response = previous_finals = previous_readbacks = previous_caller = 0
            previous_playback_started = 0
            for step in scenario['steps']:
                deadline = time.monotonic() + (90 if 'taskContext' in scenario else 55)
                pause_until = time.monotonic() + step.get('seconds', 0)
                audible_since = None
                while True:
                    state = monitor()
                    if state.get('duplicateSubmitPrompt'):
                        raise RuntimeError('duplicate-submit-prompt')
                    native_failure = next((error for error in state['errors'] if error in ('native-model-capacity', 'native-model-failed')), None)
                    if native_failure:
                        raise RuntimeError(native_failure)
                    if state['holdingAcks']:
                        raise RuntimeError('standalone-holding-acknowledgement')
                    if state['submitted'] or state['ended'] or state['errors']:
                        raise RuntimeError('call-ended-before-dialogue-finished')
                    now = time.time()
                    quiet = now - state['lastVoicedAt'] / 1000 >= .8 and now - last_loud[0] >= .8
                    response = response_for_step(state, step['after'], previous_playback_started,
                                                 previous_caller if played else None)
                    fresh = bool(response and response['id'] > previous_response
                                 and response['startedAt'] >= previous_playback_started)
                    complete = bool(fresh and response['finalAt'] and not response['interrupted']
                                    and response['wordCount'] >= (2 if step['after'] == 'readback' else 3)
                                    and state['assistantFinals'] > previous_finals and response['category'] != 'holding')
                    new_readback = bool(fresh and response['readback'] == state['readbacks'] > previous_readbacks
                                        and response['startedAt'] >= state['readbackAt'])
                    heard = bool(response and response['firstAudioAt'] and response['lastAudioAt']
                                 and last_loud[0] >= response['firstAudioAt'] / 1000 - .1)
                    if step['after'] == 'during-readback':
                        # Actual bridge audio plus fresh physical playback; never a silence-only delay.
                        audible = new_readback and heard and not response['interrupted'] and now - last_loud[0] < .2
                        if audible:
                            if audible_since is None:
                                audible_since = time.monotonic()
                        else:
                            audible_since = None
                        ready = audible_since is not None and time.monotonic() - audible_since >= step['seconds']
                    elif step['after'] == 'pause':
                        ready = time.monotonic() >= pause_until
                    elif step['after'] == 'readback':
                        ready = complete and new_readback and response['category'] == 'readback' and 'submit' in response['words']
                    elif step['after'] == 'opening':
                        words = set(response['words']) if response else set()
                        ready = complete and response['category'] == 'opening' and set(scenario['openingWords']) <= words
                        ready = ready and (not scenario['openingAny'] or bool(set(scenario['openingAny']) & words))
                    else:
                        # A realtime final, not a desktop append or a consultation, ends an answer.
                        ready = complete and response['category'] == 'answer'
                    observed = set(response['words']) if response else set()
                    ready = ready and all(set(group) & observed for group in step.get('spokenWords', []))
                    if ready and (step['after'] == 'during-readback' or quiet and heard):
                        break
                    if time.monotonic() > deadline or instrument.poll() is not None:
                        raise RuntimeError('expected-complete-spoken-turn-not-heard')
                    time.sleep(.05)
                previous_response = state['responseSeq']
                previous_finals = state['assistantFinals']
                previous_readbacks = state['readbacks']
                previous_caller = state['callerTurns']
                previous_playback_started = round(time.time() * 1000)
                playback = {'say': step['say'], 'startedAt': previous_playback_started, 'finishedAt': None, 'after': step['after'],
                            'submittedBefore': state['submitted'], 'responseAfter': previous_response,
                            'assistantFinals': state['assistantFinals'], 'spokenWords': response['words'] if response else [],
                            'readbacks': state['readbacks'], 'assistantVoicedAt': state['lastVoicedAt'],
                            'speakerLoudAt': round(last_loud[0] * 1000)}
                played.append(playback)
                sd.play(audio[step['say']], RATE, device=options.speaker, blocking=True)
                playback['finishedAt'] = round(time.time() * 1000)
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
        try:
            if instrument is not None:
                try:
                    instrumentation = instrument.communicate(timeout=12)[0]
                except subprocess.TimeoutExpired:
                    adb(options, 'shell', 'am', 'force-stop', TARGET)
                    try:
                        instrumentation = instrument.communicate(timeout=5)[0]
                    except subprocess.TimeoutExpired:
                        instrument.kill()
                        instrumentation = instrument.communicate(timeout=5)[0]
                        failure = failure or 'instrumentation-did-not-stop'
        except (OSError, subprocess.SubprocessError):
            failure = failure or 'instrumentation-cleanup-failed'
            if instrument is not None and instrument.poll() is None:
                instrument.kill()
                instrument.communicate(timeout=5)
        finally:
            try:
                if process.isalive():
                    subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=10)
            finally:
                if reverse_owned:
                    try:
                        adb(options, 'reverse', '--remove', 'tcp:19583')
                    except (OSError, subprocess.SubprocessError):
                        failure = failure or 'reverse-cleanup-failed'
    result = Path(str(trace) + '.result')
    if result.exists():
        state = json.loads(result.read_text())
    if state.get('messages') == 0:
        failure = next((error for error in state.get('errors', []) if error in ('native-model-capacity', 'native-model-failed')), failure)
    passed = (not failure and len(played) == len(scenario['steps']) and all(item['submittedBefore'] == 0 for item in played)
              and state.get('holdingAcks') == 0 and state.get('submitted') == 1 and state.get('delivery') == 'accepted'
              and state.get('nativeEnded') and state.get('values') == scenario['expected'] and not state.get('errors')
              and 'OK (1 test)' in instrumentation)
    latency = []
    for response in state.get('responses', []):
        candidates = [(index, item) for index, item in enumerate(played)
                      if item['finishedAt'] is not None and response['id'] > item['responseAfter'] and response['startedAt'] >= item['startedAt']]
        caller = candidates[-1] if candidates else None
        first_audio = response['firstAudioAt'] or None
        delay = first_audio - caller[1]['finishedAt'] if first_audio is not None and caller else None
        latency.append({'response': response['id'], 'callerStep': caller[0] + 1 if caller else None,
                        'category': response['category'], 'interrupted': response['interrupted'],
                        'firstAudioAt': first_audio, 'lastAudioAt': response['lastAudioAt'] or None,
                        'assistantFinalAt': response['finalAt'] or None, 'audioLatencyMs': delay,
                        'overlappedCallerPlayback': delay < 0 if delay is not None else None})
    report = {'scenario': scenario['name'], 'passed': bool(passed), 'failure': failure, 'played': played, 'state': state,
              'responseLatency': latency, 'latencyBasis': 'observed desktop-to-phone PCM minus synthetic speaker playback completion; not handset ASR or end-to-end network latency',
              'instrumentation': instrumentation, 'peakRms': peak[0], 'transcripts': [str(p) for p in Path(str(trace) + '.state/calls').glob('*.jsonl')]}
    (directory / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scenario', nargs='*', help='Scenario names; defaults to direct')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--scenarios', type=Path, default=ROOT / 'test/acoustic.json', help='Bounded synthetic scenario JSON')
    parser.add_argument('--list-audio', action='store_true', help='Discover audio indices without operating on a phone')
    parser.add_argument('--include-barge-in', action='store_true', help='Opt in to physical interruption during audible readback')
    parser.add_argument('--mic', type=int, default=os.environ.get('OMP_AWAY_ACOUSTIC_MIC'), help='Explicit sounddevice input index')
    parser.add_argument('--speaker', type=int, default=os.environ.get('OMP_AWAY_ACOUSTIC_SPEAKER'), help='Explicit sounddevice output index')
    args = parser.parse_args()
    if args.list_audio:
        print(sd.query_devices())
        return
    try:
        scenarios = load_scenarios(args.scenarios)
    except (OSError, ValueError):
        parser.error('Invalid bounded synthetic scenario file')
    names = args.scenario or ['direct']
    selected = [s for s in scenarios if not s.get('bargeIn') or args.include_barge_in] if args.all else [s for s in scenarios if s['name'] in names]
    if not selected or not args.all and set(names) - {s['name'] for s in selected}:
        parser.error('Unknown scenario')
    if any(s.get('bargeIn') for s in selected) and not args.include_barge_in:
        parser.error('Barge-in scenarios require --include-barge-in and physical overlap-capable audio')
    try:
        settings(parser, args)
    except (OSError, subprocess.SubprocessError, sd.PortAudioError):
        parser.error('Device, disposable APK, or explicit audio setup unavailable')
    if Path(tempfile.gettempdir()).resolve().is_relative_to(ROOT.parent):
        parser.error('Set TEMP/TMP to a directory outside the repository')
    directory = Path(tempfile.mkdtemp(prefix='away-dialogues-'))
    audio = synthesize(selected, directory, args.speaker_channels)
    success = True
    for scenario in selected:
        report = run(scenario, directory / scenario['name'], audio, args)
        success = success and report['passed']
        print(json.dumps({'scenario': scenario['name'], 'passed': report['passed'], 'failure': report['failure'], 'report': str(directory / scenario['name'] / 'result.json')}), flush=True)
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    main()
