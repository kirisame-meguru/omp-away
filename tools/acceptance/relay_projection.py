"""Offline: Wireshark Follow TCP Stream / Raw, both directions saved separately, from the owned nginx→relay /v1/phone upgrade. Inputs MAY CONTAIN A BEARER; never publish them."""
import argparse
import hashlib
import json
import sys
from pathlib import Path


def check(ok):
    if not ok:
        raise ValueError('invalid, incomplete or unsupported stream')


def unframe(raw, client, prefix=False, boundaries=None):
    end = raw.find(b'\r\n\r\n',0,32768)
    check(end > 0)
    headers = raw[:end].split(b'\r\n')
    check(headers[0] == b'GET /v1/phone HTTP/1.1' if client else headers[0].startswith(b'HTTP/1.1 101 '))
    check(any(h.lower().strip() == b'upgrade: websocket' for h in headers[1:]))
    pos, fragmented, closed = end+4, False, False
    body = bytearray()
    while pos < len(raw):
        if prefix and pos+2>len(raw): break
        a,b = raw[pos:pos+2]; pos += 2
        fin, op, size = bool(a&128), a&15, b&127
        check(not closed and a&112 == 0 and bool(b&128) == client)
        if size >= 126:
            n = 2 if size == 126 else 8
            if prefix and pos+n>len(raw): break
            check(pos+n <= len(raw)); size = int.from_bytes(raw[pos:pos+n],'big'); pos += n
        key = raw[pos:pos+4] if client else None
        if client: pos += 4
        if prefix and pos+size>len(raw): break
        check(pos+size <= len(raw))
        payload = memoryview(raw)[pos:pos+size]; pos += size
        if op in (8,9,10):
            check(fin and size <= 125); closed = op == 8; continue
        check(op == (0 if fragmented else 2)); fragmented = not fin
        if client:
            # Browser/OkHttp masking is not encryption. Inspect the unmasked payload.
            body.extend(x ^ key[i%4] for i,x in enumerate(payload))
        else:
            body.extend(payload)
        if boundaries is not None and (not boundaries or boundaries[-1][0]!=len(body)):
            boundaries.append((len(body),pos))
    check((prefix or not fragmented) and body)
    return body


def hello13(h, client):
    check(h[0] == (1 if client else 2))
    end = 4+int.from_bytes(h[1:4],'big'); check(39 <= end <= len(h))
    pos = 39+h[38]  # handshake header + legacy version + random + session ID
    if client:
        pos += 2+int.from_bytes(h[pos:pos+2],'big')
        pos += 1+h[pos]
    else: pos += 3  # selected cipher, compression
    check(pos+2+int.from_bytes(h[pos:pos+2],'big') == end); pos += 2
    found = False
    while pos < end:
        check(pos+4 <= end)
        tag = int.from_bytes(h[pos:pos+2],'big'); size = int.from_bytes(h[pos+2:pos+4],'big'); pos += 4
        check(pos+size <= end); v=h[pos:pos+size]; pos += size
        if tag == 43:
            check(not found)
            if client:
                check(size>=3 and v[0]==size-1 and v[0]%2==0)
                found = any(v[k:k+2]==b'\x03\x04' for k in range(1,size,2))
            else: found = v == b'\x03\x04'
    return found


def records(data, client, prefix=False):
    pos, count, total = 0,0,0
    handshake = bytearray()
    while pos < len(data):
        if prefix and pos+5>len(data): break
        check(pos+5<=len(data)); kind = data[pos]; size = int.from_bytes(data[pos+3:pos+5],'big')
        check(data[pos+1] == 3 and data[pos+2] in (1,3) and 0 < size <= 16640)
        if prefix and pos+5+size>len(data): break
        check(pos+5+size<=len(data))
        pos+=5
        if kind == 22:
            check(count == 0 and len(handshake)+size <= 131072); handshake.extend(data[pos:pos+size])
        elif kind == 23:
            count+=1; total+=size
        else: check(kind==20 and size==1 and data[pos]==1)  # dummy change_cipher_spec
        pos+=size
    result={'tls13':hello13(handshake,client),'applicationRecords':count,'applicationBytes':total}
    if prefix: result['validatedBytes']=pos
    return result


def summarize(run, uplink, downlink):
    canary = ('AWAY-CHECK-'+run).encode('ascii')
    summary = {'run':run,'scope':'/v1/phone','canarySha256':hashlib.sha256(canary).hexdigest(),'canaryHits':0}
    digest = hashlib.sha256()
    for raw, key, client in ((uplink,'phone',True),(downlink,'desktop',False)):
        data = unframe(raw, client)
        summary['canaryHits'] += data.count(canary)
        summary[key] = records(data,client)
        # Only ciphertext bytes are hashed, never HTTP credentials or mask keys.
        digest.update(len(data).to_bytes(8,'big')); digest.update(data)
    summary['streamSha256'] = digest.hexdigest()
    return summary


def project(root, uplink, downlink):
    run = json.loads((root/'scenario.json').read_text(encoding='utf-8'))['run']
    for path in (uplink, downlink):
        check(0 < path.stat().st_size <= 128*1024*1024)
    summary = summarize(run, uplink.read_bytes(), downlink.read_bytes())
    with (root/'relay.json').open('x',encoding='utf-8') as f:
        json.dump(summary,f,indent=2); f.write('\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path); parser.add_argument('nginx_to_relay',type=Path); parser.add_argument('relay_to_nginx',type=Path)
    a=parser.parse_args()
    try: project(a.directory,a.nginx_to_relay,a.relay_to_nginx)
    except (OSError, KeyError, IndexError, ValueError, TypeError):
        print('STOP: absent, ambiguous, oversized, truncated, non-binary or unsupported capture; no raw output.',file=sys.stderr); sys.exit(1)
    print('Projected bidirectional inner TLS. Verify interval, provenance and limitations separately.')
