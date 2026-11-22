"""Offline reduced observations from classic tcpdump -i lo -s 0 'tcp port 8787'. No sockets, subprocesses or raw exports."""
import argparse
import json
import re
import struct
import sys
import time
from pathlib import Path

from invite_projection import summarize as invite_summary
from relay_projection import records, summarize as phone_summary, unframe

MAX_FILE = 96 * 1024 * 1024
MAX_DIRECTION = 32 * 1024 * 1024
MAX_PACKETS = 200_000
MAX_STREAMS = 256
PORT = 8787
MASK32 = 0xffffffff


def check(ok):
    if not ok:
        raise ValueError('unsupported or incomplete capture')


def u16(data, pos):
    return struct.unpack_from('!H', data, pos)[0]


def tcp(packet, link):
    if link == 1:  # Linux loopback capture commonly uses Ethernet encapsulation
        check(len(packet) >= 14); proto, off = u16(packet,12),14
    elif link == 113:  # Linux cooked v1
        check(len(packet) >= 16); proto, off = u16(packet,14),16
    elif link == 276:  # Linux cooked v2
        check(len(packet) >= 20); proto, off = u16(packet,0),20
    else: raise ValueError()
    if proto == 0x800:
        check(len(packet)>=off+20 and packet[off]>>4 == 4 and packet[off+9] == 6 and u16(packet,off+6)&0x3fff == 0)
        size=(packet[off]&15)*4; end=off+u16(packet,off+2)
        src,dst=packet[off+12:off+16],packet[off+16:off+20]
        check(size>=20 and src[0] == dst[0] == 127); off+=size
    elif proto == 0x86dd:
        check(len(packet)>=off+40 and packet[off]>>4 == 6 and packet[off+6] == 6)
        src,dst=packet[off+8:off+24],packet[off+24:off+40]
        check(src == dst == bytes(15)+b'\x01'); end=off+40+u16(packet,off+4); off+=40
    else: raise ValueError()
    check(off+20<=end<=len(packet)); sport,dport,seq=struct.unpack_from('!HHI',packet,off)
    check((sport==PORT) != (dport==PORT)); up=dport==PORT
    key=(src,sport,dst,dport) if up else (dst,dport,src,sport)
    size=(packet[off+12]>>4)*4; check(20<=size<=end-off)
    return key, 0 if up else 1, seq, packet[off+13], packet[off+size:end]


class Half:
    def __init__(self):
        self.base = None; self.fin = None; self.parts = []; self.bytes = 0

    def packet(self, seq, flags, payload, ms):
        if flags&2:
            base=(seq+1)&MASK32
            check(self.base in (None,base)); self.base=base; seq=base
        if self.base is None:
            return
        off=(seq-self.base)&MASK32
        # In-window TCP keepalive probe at SND.NXT-1, including ISN probe.
        if off==MASK32 and len(payload)<=1 and not flags&3: return
        if not payload and not flags&1: return
        check(off+len(payload)<=MAX_DIRECTION)
        if flags&1:
            check(self.fin in (None,off+len(payload))); self.fin=off+len(payload)
        if payload:
            self.bytes+=len(payload); check(self.bytes<=MAX_FILE)
            self.parts.append((off,ms,payload))

    def reassemble(self):
        data=bytearray(); spans=[]; extent_time=0; issue=None
        for off,ms,payload in sorted(self.parts,key=lambda p:(p[0],p[1])):
            if off>len(data):
                issue='tcp-gap'; break
            overlap=min(len(payload),len(data)-off)
            if data[off:off+overlap] != payload[:overlap]:
                # Once two different bytes claim one offset, don't trust any prefix past it.
                del data[off:]; issue='tcp-conflicting-retransmission'; break
            if overlap<len(payload):
                data.extend(payload[overlap:]); extent_time=max(extent_time,ms); spans.append((len(data),extent_time))
        if not issue and self.fin is not None and self.fin!=len(data):
            issue='tcp-fin-sequence-mismatch'
        return bytes(data),spans,issue


def read_pcap(path):
    check(24 < path.stat().st_size <= MAX_FILE)
    start_time=time.monotonic(); by_key={}; streams=[]; first=None; last=0; packets=0
    magic={b'\xd4\xc3\xb2\xa1':('<',1000000),b'\xa1\xb2\xc3\xd4':('>',1000000),
           b'\x4d\x3c\xb2\xa1':('<',1000000000),b'\xa1\xb2\x3c\x4d':('>',1000000000)}
    with path.open('rb') as src:
        header=src.read(24); endian,scale=magic[header[:4]]
        major,minor,_,_,snap,link=struct.unpack(endian+'HHIIII',header[4:]); check((major,minor)==(2,4) and 0<snap<=1048576 and link in (1,113,276))
        while raw:=src.read(16):
            packets+=1; check(packets<=MAX_PACKETS and time.monotonic()-start_time<120)
            sec,frac,cap,actual=struct.unpack(endian+'IIII',raw); check(0<cap==actual<=snap and frac<scale)
            pkt=src.read(cap); check(len(pkt)==cap); ms=sec*1000+frac//(scale//1000)
            if first is None: first=ms
            check(abs(ms-first)<=45*60*1000); last=max(last,ms)
            key,d,seq,flags,payload=tcp(pkt,link)
            stream=by_key.get(key); new_syn=(d==0 and flags&0x12==2)
            if stream and new_syn and stream['halves'][0].base != (seq+1)&MASK32:
                check(stream['reset'] or all(h.fin is not None for h in stream['halves'])); stream=None
            if stream is None:
                check(len(streams)<MAX_STREAMS)
                stream={'halves':[Half(),Half()],'start':ms,'end':ms,'reset':False,'initial':new_syn,'traffic':False}
                by_key[key]=stream; streams.append(stream)
            stream['end']=max(stream['end'],ms); stream['reset'] |= bool(flags&4); stream['traffic'] |= bool(payload)
            stream['halves'][d].packet(seq,flags,payload,ms)
    check(packets>0); return streams,first,last,packets,start_time


def http(data, pos, request):
    end=data.find(b'\r\n\r\n',pos,min(len(data),pos+32768)); check(end>=0)
    lines=data[pos:end].split(b'\r\n'); first=lines[0].split(b' ',2); end+=4
    if request:
        check(len(first)==3 and first[2]==b'HTTP/1.1' and first[1].startswith(b'/') and b'?' not in first[1]); kind=tuple(first[:2])
    else:
        check(len(first)>=2 and first[0]==b'HTTP/1.1' and re.fullmatch(rb'\d{3}',first[1])); kind=int(first[1])
    sizes=[]
    for line in lines[1:]:
        k,_,v=line.partition(b':'); check(_ and k and not k[:1].isspace()); k=k.lower()
        if k==b'content-length':
            check(re.fullmatch(rb'[0-9]{1,8}',v.strip())); sizes.append(int(v))
        if k==b'transfer-encoding': raise ValueError()  # reject rather than guess chunk framing
    check(len(sizes)<=1)
    if not request and kind not in (101,204,304): check(len(sizes)==1)
    size=sizes[0] if sizes else 0; check(size<=65536 and end+size<=len(data))
    return kind,end+size


def time_at(spans, end):
    return next(ms for extent,ms in spans if extent>=end)


def route_of(method):
    if method==(b'GET',b'/v1/phone'): return 'phone'
    if method==(b'POST',b'/v1/invites'): return 'invite'
    if method==(b'GET',b'/v1/control'): return 'control'
    if method[0]==b'GET' and method[1].startswith(b'/v1/tunnels/'): return 'tunnel'
    return 'other'


def phone_prefix(run, start, halves):
    # Count only complete records in complete, unmasked WS frames, from offset
    # zero through the last unambiguously contiguous byte in each direction.
    result={'startMs':start,'coverage':'prefix-only','canaryHits':0}
    through=[]; canary=('AWAY-CHECK-'+run).encode('ascii')
    for raw,offset,spans,client,key in halves:
        boundaries=[]; body=unframe(raw[offset:],client,prefix=True,boundaries=boundaries)
        result[key]=r=records(body,client,prefix=True)
        valid=r['validatedBytes']; check(r['tls13'] and r['applicationRecords']>0)
        result['canaryHits']+=body.count(canary,0,valid)
        # Timestamp of actual final validated TLS byte, not FIN/RST/ACK or a
        # later partial record/control frame. No skipped gaps or invalid bytes.
        end,next_raw=next((end,pos) for end,pos in boundaries if end>=valid)
        raw_end=offset+next_raw-(end-valid)
        ms=time_at(spans,raw_end)
        r['validatedThroughMs']=ms; through.append(ms)
    result['bidirectionalThroughMs']=min(through)
    return result


def analyze(path, run):
    streams,first,last,packets,started=read_pcap(path)
    phones=[]; invites=[]; failures=[]; prefixes=[]; live_at_start=0
    for index,s in enumerate(streams,1):
        check(time.monotonic()-started<120)
        if not s['traffic']: continue
        up,down=s['halves']
        route='unknown'; stage='tcp-reassembly'; ia=ib=0; transport=[]
        def diagnostic(reason):
            failures.append({'stream':index,'route':route,'reason':reason,'startMs':s['start'],'endMs':s['end'],'tcpIssues':transport})
        if not s['initial'] or up.base is None or down.base is None:
            live_at_start+=1; diagnostic('missing-tcp-handshake'); continue
        try:
            a,sa,ea=up.reassemble(); b,sb,eb=down.reassemble()
            transport=[e for e in (ea,eb) if e]
            for _ in range(1024):
                if ia==len(a) and ib==len(b): break
                stage='http-request-framing'; route='unknown'
                method,na=http(a,ia,True); route=route_of(method)
                stage='http-response-framing'
                status,nb=http(b,ib,False)
                if method==(b'POST',b'/v1/invites'):
                    stage='invite-non-204' if status!=204 else 'invite-body-or-identity'
                    rec=invite_summary(run,a[ia:na],b[ib:nb]); invites.append((rec,time_at(sb,nb)))
                if status==101:
                    check(method[0]==b'GET')
                    if method==(b'GET',b'/v1/phone'):
                        start=time_at(sa,na)
                        stage=transport[0] if transport else ('tcp-reset' if s['reset'] else 'missing-bidirectional-fin')
                        if not transport and not s['reset'] and up.fin is not None and down.fin is not None:
                            stage='phone-websocket-or-tls-framing'
                            try:
                                rec=phone_summary(run,a[ia:],b[ib:]); phones.append((rec,start,s['end'])); break
                            except (IndexError,TypeError,ValueError): pass
                        diagnostic(stage)
                        try:
                            prefix=phone_prefix(run,start,[(a,ia,sa,True,'phone'),(b,ib,sb,False,'desktop')])
                            prefix.update(stream=index,reason=stage)
                            prefixes.append(prefix)
                        except (ValueError,IndexError,StopIteration,TypeError):
                            failures[-1]['prefixReason']='no-valid-bidirectional-tls-prefix'
                        break
                    else:
                        stage='unrecognized-upgrade'; check(route in ('control','tunnel'))
                        if transport: diagnostic(transport[0])
                    break
                stage='phone-upgrade-rejected'; check(route!='phone'); ia,ib=na,nb
            else: stage='http-transaction-limit'; raise ValueError()
            if transport and route not in ('phone','control','tunnel'): diagnostic(transport[0])
        except (ValueError,IndexError,KeyError,TypeError,StopIteration):
            diagnostic(stage)
    return {'captureStartMs':first,'captureEndMs':last,'packets':packets,'tcpStreams':len(streams),
            'preexistingUnclassified':live_at_start,'incompleteStreams':len({d['stream'] for d in failures if d['reason']!='missing-tcp-handshake'}),
            'streamDiagnostics':failures,'phonePrefixes':prefixes},phones,invites


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('run_dir',type=Path,help='private working directory containing scenario.json')
    p.add_argument('pcap',type=Path); p.add_argument('--at-ms',type=int,help='known in-call epoch ms in relay clock (select unique stream)')
    p.add_argument('--call-window-ms',nargs=2,type=int,metavar=('JOIN','HANGUP'),help='independently observed call interval in relay epoch ms')
    p.add_argument('--request-sha256',help='observed OS tag SHA-256 (select unique first invite)')
    p.add_argument('--write-projections',action='store_true',help='write create-only relay.json and invite.json on unambiguous complete evidence')
    args=p.parse_args(); sc=args.run_dir/'scenario.json'; check(sc.stat().st_size<8192); run=json.loads(sc.read_text(encoding='utf-8-sig'))['run']; check(re.fullmatch(r'[a-f0-9]{32}',run))
    check(args.request_sha256 is None or re.fullmatch(r'[a-f0-9]{64}',args.request_sha256))
    report,phones,invites=analyze(args.pcap,run)
    if args.call_window_ms is not None:
        begin,end=args.call_window_ms; check(0<begin<end)
        for r in report['phonePrefixes']:
            r['bracketsCallWindow']=r['startMs']<=begin and r['bidirectionalThroughMs']>=end
        full=sum(start<=begin and finish>=end for _,start,finish in phones)
        partial=sum(r['bracketsCallWindow'] for r in report['phonePrefixes'])
        report['callWindow']={'startMs':begin,'endMs':end,'completePhoneCandidates':full,'prefixPhoneCandidates':partial,
            'transportEvidence':('ambiguous' if full+partial>1 else 'complete-socket' if full else 'prefix-only' if partial else 'not-demonstrated')}
    report['phoneStreams']=[{'startMs':start,'endMs':end,**r} for r,start,end in phones]
    report['inviteExchanges']=[{'acceptedMs':ms,**r} for r,ms in invites]
    chosen=[r for r,start,end in phones if (args.at_ms is None or start<=args.at_ms<=end) and
            (args.call_window_ms is None or start<=args.call_window_ms[0] and end>=args.call_window_ms[1])]
    matches=[r for r,_ in invites if args.request_sha256 is None or r['request']==args.request_sha256]
    ok=(len(chosen)==len(matches)==1 and not report['incompleteStreams'] and not report['preexistingUnclassified'] and
        chosen[0]['canaryHits']==0 and all(chosen[0][k]['tls13'] and chosen[0][k]['applicationRecords']>=2 and chosen[0][k]['applicationBytes']>=960 for k in ('phone','desktop')))
    report['status']='projected' if ok else 'inconclusive'; print(json.dumps(report,separators=(',',':')))
    if not ok: return 1
    if args.write_projections:
        outputs=[(args.run_dir/'relay.json',chosen[0]),(args.run_dir/'invite.json',matches[0])]
        check(not any(path.exists() for path,_ in outputs))
        for path,r in outputs:
            with path.open('x',encoding='utf-8') as f: json.dump(r,f,indent=2); f.write('\n')
    return 0


if __name__=='__main__':
    try: sys.exit(main())
    except (ValueError,KeyError,IndexError,TypeError,struct.error,OSError,StopIteration):
        print('INCONCLUSIVE: unsupported scope, bounded capture, stream, or output; no raw data displayed.',file=sys.stderr); sys.exit(1)
