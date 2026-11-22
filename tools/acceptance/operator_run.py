"""Observe an already leased AVD. Never boot, install, inject input, change settings or submit."""
import argparse
import hashlib
import json
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path

PKG = 'ru.eleven.ompaway'
AVD = 'Pixel_10_Pro_XL_99'
ADJECTIVES = ('silver','golden','velvet','quiet','gentle','frosty','merry','misty')
NOUNS = ('falcon','willow','garden','lantern','forest','meadow','canyon','robin')


def phrase():
    return secrets.choice(ADJECTIVES) + ' ' + secrets.choice(NOUNS)


def save(path, obj):
    with path.open('x', encoding='utf-8') as f:
        json.dump(obj, f, indent=2); f.write('\n')


def init(path):
    path.mkdir(mode=0o700)  # require new directory under a private parent
    marker, note = phrase(), phrase()
    while marker == note:
        note = phrase()
    save(path / 'scenario.json', {'run':secrets.token_hex(16),'marker':marker,'note':note})
    print('Created nonsecret scenario. Do not show the voice-only note to the coding session.')


def require(ok, msg):
    if not ok:
        raise ValueError(msg)


def live(root, adb, serial, audio_source):
    require(re.fullmatch(r'emulator-[0-9]+',serial), 'Expected an explicit emulator serial')
    sc = json.loads((root/'scenario.json').read_text(encoding='utf-8'))
    require(not (root/'android.json').exists(), 'Evidence already exists')
    def run(*args):
        p = subprocess.run([adb,'-s',serial,*args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=15, check=False)
        require(p.returncode == 0, 'ADB read failed; no device output recorded')
        return p.stdout.decode('utf-8','replace')
    require(run('emu','avd','name').splitlines()[0].strip() == AVD, 'Serial is not the approved AVD')
    package = run('shell','dumpsys','package',PKG)
    version = re.search(r'^\s*versionName=([0-9a-zA-Z._+-]{1,80})\s*$',package,re.M)
    code = re.search(r'^\s*versionCode=(\d+)\b',package,re.M)
    require(version and code, 'Missing installed package/version')
    require(re.search(r'android\.permission\.POST_NOTIFICATIONS: granted=true\b',package), 'Grant notification permission through Android first')
    paths = run('shell','pm','path',PKG).strip().splitlines()
    require(len(paths)==1 and re.fullmatch(r'package:/data/app/[a-zA-Z0-9_.~+/=-]+/base\.apk',paths[0]), 'Expected one installed base APK; check exact build before extending collector')
    apk = run('shell','sha256sum',paths[0][8:]).split()[0]
    build = run('shell','getprop','ro.build.id').strip()
    require(re.fullmatch('[0-9a-f]{64}',apk) and re.fullmatch(r'[A-Za-z0-9._-]{1,100}',build), 'Missing installed build identity')
    data = {'run':sc['run'],'package':PKG,'serial':serial,'avd':AVD,'route':'away.example.invalid','build':build,'version':version[1], 'versionCode':int(code[1]),'apkSha256':apk,'notificationPermission':True,'activeInviteCounts':[], 'steps':{}}
    data['audioSource'] = audio_source
    if audio_source == 'emulator-test-mic':
        print('Controller test mic declared. For each spoken action provide caller PCM through the authorized emulator mic. Listen to actual speaker output; never synthesize provider audio or inject transcripts.')
    def mark(name):
        data['steps'][name] = time.time_ns()//1_000_000
    def witness(instruction):
        require(input(instruction+'\nType SEEN only if observed: ').strip() == 'SEEN', 'Observation not confirmed')
    def keys():
        lines = run('shell','cmd','notification','list').splitlines()
        require(not any(re.search('error|denial|exception|unknown command',line,re.I) for line in lines), 'Notification list unreadable')
        found = []
        for line in lines:
            parts = line.strip().split('|')
            if len(parts)>=4 and parts[1] == PKG and parts[2] == '1':
                require(re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}',parts[3]), 'Unexpected invite identity')
                found.append(hashlib.sha256(parts[3].encode()).hexdigest())
        data['activeInviteCounts'].append(len(found))
        return found
    def focused():
        w = run('shell','dumpsys','window','windows')
        if not re.search(r'mCurrentFocus=[^\n]*\b'+re.escape(PKG)+r'/', w):
            w = run('shell','dumpsys','window')
        require(re.search(r'mCurrentFocus=[^\n]*\b'+re.escape(PKG)+r'/',w), 'Away is not the focused activity')
    witness('Confirm the lease, private workspace, paired pins, actual Codex login, Google Play services, enabled audio, and both capture points. Leave Away in background; do not force-stop.')
    require(not keys(), 'Start with no outstanding invitations'); mark('baseline')
    print('Give the DESKTOP the single runbook prompt now (not the voice note). Name of Blue lane disposable test environment:',sc['marker'],'; look for this inbox project marker: AWAY-CHECK-'+sc['run'])
    witness('See the native Ask open, untouched, and the real OS shade notification: Desktop request / Open your inbox to review. No private question or options.')
    active = keys(); require(len(active)==1, 'Expected exactly one active request notification'); data['request']=active[0]; mark('invite')
    witness('Tap Not now on the notification. Verify the invitation vanishes, the native Ask remains, no call starts.')
    require(not keys(),'Request notification is still active'); mark('dismissed')
    witness('Open the app explicitly, refresh its authenticated inbox. Find the pending lane question under the exact project marker above, not just a cached/missed entry. Do not hang up or disconnect during the rest of the positive run.')
    focused(); mark('inbox')
    witness('Tap Answer by voice (grant microphone in the UI first). See Microphone and playback on.')
    focused(); mark('joined')
    witness('Hear the actual question and brief through the emulator audio output, not from desktop TTS. Desktop Ask is still open.')
    mark('heardBrief')
    input('Before speaking, press Enter. Then ask aloud: What is the name of the disposable test environment for Blue lane? '); mark('askClarification')
    words = input('After the spoken reply, type ONLY the two-word environment name you actually HEARD: ').strip().lower()
    require(words == sc['marker'],'Spoken clarification did not name the correct Blue test environment'); data['heardMarker']=words; mark('heardClarification')
    input('Desktop form still pending? Press Enter BEFORE speaking; then say: My answer is Blue lane; my test note is '+sc['note']+'. '); mark('propose')
    words = input('After hearing the COMPLETE readback including Blue lane and the random challenge, type only the note actually read back: ').strip().lower()
    require(words == sc['note'], 'Audible readback mismatch'); data['observedReadback']=words; mark('heardReadback')
    witness('The original desktop form is STILL open. Do not touch it. You have not confirmed yet.'); mark('confirm')
    witness('Now speak the exact requested affirmative and the fresh challenge. Hear/see the call end. Verify the original form closes, Codex reports both values, the composer returns and the refreshed authenticated inbox no longer contains the request.')
    focused(); mark('finished')
    save(root/'android.json',data)
    print('Recorded serial-bound snapshots and human observations; not a pass by itself.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('init','live'):
        cmd = sub.add_parser(name); cmd.add_argument('directory',type=Path)
        if name == 'live':
            cmd.add_argument('--serial',required=True); cmd.add_argument('--adb',default='adb')
            cmd.add_argument('--audio-source',choices=('human-mic','emulator-test-mic'),default='human-mic')
    args = parser.parse_args()
    try:
        if args.command == 'init': init(args.directory)
        else: live(args.directory,args.adb,args.serial,args.audio_source)
    except (ValueError, OSError, IndexError, KeyError, EOFError, subprocess.SubprocessError, KeyboardInterrupt) as e:
        print('STOP:',str(e) if type(e) is ValueError else 'incomplete; no live pass',file=sys.stderr); sys.exit(1)
