"""Offline: reduce one actual post-TLS HTTP/1.1 POST /v1/invites exchange. Raw files contain credentials."""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


def summarize(run, req, res):
    if any(not 0 < len(p) <= 65536 for p in (req,res)):
        raise ValueError()
    header, body = req.split(b'\r\n\r\n',1)
    status, extra = res.split(b'\r\n\r\n',1)
    if (header.splitlines()[0] != b'POST /v1/invites HTTP/1.1' or
        not re.fullmatch(rb'HTTP/1\.1 204(?: [^\r\n]*)?',status.splitlines()[0]) or extra):
        raise ValueError()
    def unique(pairs):
        d=dict(pairs)
        if len(d)!=len(pairs): raise ValueError()
        return d
    payload=json.loads(body,object_pairs_hook=unique)
    if set(payload)!={'deviceId','requestId'} or not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}',payload['requestId']): raise ValueError()
    return {'run':run,'request':hashlib.sha256(payload['requestId'].encode()).hexdigest(),'status':204}


def project(root, req, res):
    if any(not 0 < p.stat().st_size <= 65536 for p in (req,res)):
        raise ValueError()
    run=json.loads((root/'scenario.json').read_text(encoding='utf-8'))['run']
    result=summarize(run, req.read_bytes(), res.read_bytes())
    with (root/'invite.json').open('x',encoding='utf-8') as f:
        json.dump(result,f); f.write('\n')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('directory',type=Path); p.add_argument('request',type=Path); p.add_argument('response',type=Path); a=p.parse_args()
    try: project(a.directory,a.request,a.response)
    except (OSError,KeyError,ValueError,IndexError,TypeError):
        print('STOP: not one successful first-use invite exchange; raw content withheld.',file=sys.stderr); sys.exit(1)
    print('Recorded authenticated route acknowledgement. Does not establish device delivery.')
