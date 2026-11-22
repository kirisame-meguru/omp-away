"""Offline verifier for one isolated paid voice run. No network, adb, or model calls."""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def unique_pairs(pairs):
    d = {}
    for key, value in pairs:
        require(key not in d, 'duplicate JSON key')
        d[key] = value
    return d


def load(path, lines=False):
    text = path.read_text(encoding='utf-8-sig')
    parse = lambda x: json.loads(x, object_pairs_hook=unique_pairs)
    return [parse(x) for x in text.splitlines()] if lines else parse(text)


def verify(root):
    sc = load(root / 'scenario.json')
    device = load(root / 'android.json')
    log = load(root / 'host.ndjson', True)
    net = load(root / 'network.json')
    wire = load(root / 'relay.json')
    invite = load(root / 'invite.json')
    require(set(invite) == {'run','request','status'} and invite['status'] == 204 and invite['run'] == sc['run'] and invite['request'] == device['request'], 'fresh invite exchange does not match OS notification')
    decisions = load(root / 'decision.ndjson', True)
    require([d['event'] for d in decisions] == ['readback','provisional','mark','played'], 'missing, duplicate or unordered confirmation transitions')
    require(all(set(d) == {'event','at','request','mark'} and type(d['at']) is int and d['request'] == device['request'] and re.fullmatch('[0-9a-f]{64}', d['mark']) for d in decisions), 'invalid request-scoped confirmation trace')
    require(len({d['mark'] for d in decisions}) == 1 and [d['at'] for d in decisions] == sorted(d['at'] for d in decisions), 'readback replaced or out of order')
    require(set(sc) == {'run','marker','note'} and all(re.fullmatch('[a-z]+ [a-z]+',sc[k]) for k in ('marker','note')) and sc['marker'] != sc['note'], 'invalid scenario markers')
    require(set(net) == {'run','startMs','endMs','dropped','uidCoverage','ipCoverage','unclassified','flows','fcmAcceptedMs','fcmRequest','liveModel','liveObservation','pairing','relayStartMs','relayEndMs','relayDrops','relayStreams'}, 'unexpected network evidence fields')
    run = sc['run']
    require(re.fullmatch(r'[0-9a-f]{32}', run) and all(v['run'] == run for v in [device, net, wire, *log]), 'mixed runs')
    require(device['avd'] == 'Pixel_10_Pro_XL_99' and device['package'] == 'ru.eleven.ompaway' and re.fullmatch(r'emulator-\d+', device['serial']), 'wrong handset')
    require(re.fullmatch('[0-9a-f]{64}', device['apkSha256']) and device['version'] and device['build'], 'missing installed build identity')
    require(device['route'] == 'away.example.invalid' and device['notificationPermission'] is True, 'bad handset baseline')
    require(device['audioSource'] in ('human-mic','emulator-test-mic'), 'caller microphone provenance is required')
    def one(kind):
        rows = [e for e in log if e['event'] == kind]
        require(len(rows) == 1, 'expected exactly one ' + kind)
        return rows[0]
    expected = {'session','agent-start','ask-start','offered','model-asked','native-end','model-received','agent-end','shutdown','brief','consult','extract'}
    require({r['event'] for r in log} == expected, 'unexpected or missing host events')
    events = {k: one(k) for k in expected}
    h = lambda k: events[k]['at']
    require(len({r['session'] for r in log}) == 1 and re.fullmatch('[0-9a-f]{64}', one('session')['session']), 'host session changed')
    tool = one('offered')['tool']
    require(re.fullmatch('[0-9a-f]{64}', tool) and all(one(k)['tool'] == tool for k in ['ask-start','model-asked','native-end']), 'not the original Ask')
    require(one('ask-start')['builtin'] is True and one('session')['canary'] is True, 'missing native form or project canary')
    require(one('model-asked')['paidCodex'] is True and one('model-received')['paidCodex'] is True, 'not desktop Codex')
    require(one('native-end')['values'] == {'mode':'blue','note':sc['note']} and one('native-end')['ok'] is True, 'wrong native HTML field values or timeout')
    require(one('model-received')['echo'] is True, 'main coding model did not report the returned values')
    require(h('agent-start') <= h('ask-start') <= h('offered') <= h('native-end') <= h('model-received') <= h('agent-end') <= h('shutdown'), 'main lifecycle out of order')
    require(len({one(k)['entry'] for k in ['brief','consult','extract']}) == 3 and all(one(k)['paidCodex'] is True and one(k)['ok'] is True for k in ['brief','consult','extract']), 'missing distinct settled side turns')
    require(one('brief')['marker'] is False and one('consult')['marker'] is True, 'clarification marker missing or leaked by brief')
    p = device['steps']
    stages = ['baseline','invite','dismissed','inbox','joined','heardBrief','askClarification','heardClarification','propose','heardReadback','confirm','finished']
    require(list(p) == stages and all(type(t) is int and t > 0 for t in p.values()) and list(p.values()) == sorted(p.values()), 'missing or unordered operator stages')
    require(p['baseline'] <= h('ask-start') <= h('offered') <= p['invite'] and device['request'] == one('offered')['request'] and re.fullmatch('[0-9a-f]{64}', device['request']), 'notification not bound to this offer')
    require(device['activeInviteCounts'] == [0,1,0] and device['heardMarker'] == sc['marker'] and device['observedReadback'] == sc['note'], 'notification lifecycle or acoustic observation failed')
    require(h('offered') <= h('brief') <= p['heardBrief'] and p['askClarification'] <= h('consult') <= p['heardClarification'] and p['propose'] <= h('extract') <= p['heardReadback'], 'side turns not in their live voice windows')
    require(p['confirm'] < h('native-end') <= p['finished'], 'native answer early or absent at completion')
    require(h('extract') <= decisions[0]['at'] <= p['heardReadback'] and p['confirm'] <= decisions[1]['at'] <= decisions[-1]['at'] <= h('native-end'), 'confirmation trace outside human and native result boundaries')
    require(net['startMs'] <= p['baseline'] and net['endMs'] >= p['finished'] and net['dropped'] == 0 and type(net['dropped']) is int, 'incomplete capture interval')
    require(net['uidCoverage'] == 'app+gms' and net['ipCoverage'] == 'all-enabled-families' and net['unclassified'] == 0 and type(net['unclassified']) is int, 'unattributed or unclassified egress')
    allowed = {'firebaseinstallations.googleapis.com':{443},'fcmregistrations.googleapis.com':{443},'android.clients.google.com':{443},'mtalk.google.com':{443,5228,5229,5230}}
    for n in range(1,9):
        allowed[f'alt{n}-mtalk.google.com'] = allowed['mtalk.google.com']
    saw_relay = saw_google = False
    for f in net['flows']:
        require(set(f) == {'uid','host','port','transport','tx','rx'}, 'unexpected flow evidence fields')
        uid, dest, port = f['uid'], f['host'], f['port']
        require(uid in ('app','gms') and f['transport'] in ('tcp','udp') and type(port) is int and all(type(f[k]) is int and f[k] >= 0 for k in ('tx','rx')) and f['tx']+f['rx'] > 0, 'invalid egress flow')
        if uid == 'app' and dest == 'away.example.invalid' and port == 443 and f['transport'] == 'tcp':
            saw_relay |= min(f['tx'], f['rx']) > 0
        else:
            require(port in allowed.get(dest, set()), 'unexpected handset destination (details withheld)')
            saw_google |= uid == 'gms' and min(f['tx'], f['rx']) > 0
    require(saw_relay and saw_google, 'missing bidirectional relay or Google traffic')
    require(net['fcmAcceptedMs'] >= h('offered') and net['fcmAcceptedMs'] <= p['invite'] and net['fcmRequest'] == device['request'], 'FCM sender/notification mismatch')
    require(net['liveModel'] == 'gpt-live-1-codex' and net['liveObservation'] == 'desktop-signaling' and net['pairing'] == 'both-confirmed-pinned-reconnect', 'missing signaling or authenticated pairing observation')
    require(wire['scope'] == '/v1/phone' and wire['canaryHits'] == 0 and wire['canarySha256'] == hashlib.sha256(('AWAY-CHECK-'+run).encode()).hexdigest(), 'relay plaintext or unrelated sentinel')
    require(net['relayStartMs'] <= p['inbox'] and net['relayEndMs'] >= h('native-end') and net['relayDrops'] == 0 and net['relayStreams'] == [wire['streamSha256']], 'relay capture coverage or stream identity missing')
    for k in ('phone','desktop'):
        require(wire[k]['applicationRecords'] >= 2 and wire[k]['applicationBytes'] >= 960 and wire[k]['tls13'] is True, 'no full bidirectional TLS 1.3 data evidence')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    try:
        verify(args.directory)
    except (ValueError, KeyError, OSError, TypeError, IndexError, AttributeError) as e:
        # Never echo arbitrary fields from a malformed/private document.
        print('INCOMPLETE/FAIL:', str(e) if type(e) is ValueError and not isinstance(e, json.JSONDecodeError) else 'missing or malformed evidence', file=sys.stderr)
        sys.exit(1)
    print('PASS: correlated voice-run evidence; scope and limitations in docs/DEBUG.md. Not a negative-case or deployment signoff.')
