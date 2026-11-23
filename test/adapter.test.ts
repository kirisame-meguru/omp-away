import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { COLLAB_PROTO, packEnvelope, unpackEnvelope, type CollabUiRequest, type GuestFrame } from '@oh-my-pi/pi-wire';
import { startAdapter } from '../src/collab/adapter';

const session = 'fixture-session';
const room = 'test-local-host-room';
const instance = 'abc12345';
let dir: string, root: string;
let oldConfig: string | undefined;
const cleanup: Array<() => void | Promise<void>> = [];
const events = new EventEmitter();
interface Received<F extends GuestFrame = GuestFrame> { peer: number; frame: F }
type ReceivedHello = Received<Extract<GuestFrame, { t: 'hello' }>>;

beforeEach(async () => {
  // Short POSIX socket paths avoid the native long-path fallback directory.
  root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'away-reg-'));
  dir = join(root, 'run', 'collab-hosts');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  oldConfig = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = relative(homedir(), root);
});
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  if (oldConfig === undefined) delete process.env.PI_CONFIG_DIR;
  else process.env.PI_CONFIG_DIR = oldConfig;
  await rm(root, { recursive: true, force: true });
});

async function until(predicate: () => boolean) {
  while (!predicate()) await once(events, 'change');
}

test('an occupied configured port gets an independent loopback adapter without taking over its owner',async()=>{
  const owner=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('existing owner')});
  cleanup.push(()=>owner.stop(true));
  const adapter=await startAdapter(owner.port!,session,{request(){},end(){},lost(){}});
  cleanup.push(()=>adapter.close());
  expect(adapter.port).not.toBe(owner.port);
  expect(await (await fetch(`http://127.0.0.1:${owner.port}/`)).text()).toBe('existing owner');
  expect((await fetch(`http://127.0.0.1:${adapter.port}/`)).status).toBe(404);
});

async function fixture() {
  const requests: CollabUiRequest[] = [], ended: number[] = [], problems: string[] = [];
  let lost = 0, ready = 0;
  const adapter = await startAdapter(0, session, {
    request: r => { requests.push(r); events.emit('change'); },
    end: id => { ended.push(id); events.emit('change'); },
    lost: () => { lost++; events.emit('change'); },
    ready: () => { ready++; events.emit('change'); },
    unavailable: message => { problems.push(message); events.emit('change'); },
  });
  cleanup.push(() => adapter.close());
  const origin = `ws://127.0.0.1:${adapter.port}`;
  const key = randomBytes(32), writer = randomBytes(16), bearer = randomBytes(32).toString('hex');
  const state = { pid: process.pid, sessionId: session, generation: 4, linkOrigin: origin, participants: 1, relayConnected: true };
  const calls: string[] = [];
  let nextSnapshot: (() => Promise<void>) | undefined;
  function holdSnapshot() {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    nextSnapshot = () => { entered.resolve(); return release.promise; };
    cleanup.push(release.resolve);
    return { entered: entered.promise, release: release.resolve };
  }
  async function publish(pid = process.pid) {
    const operations: string[] = [];
    const id = randomBytes(8).toString('hex');
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\omp-${id}-${Bun.hash.xxHash64(dir.toLowerCase()).toString(16).padStart(16, '0')}` : join(dir, `${id}.sock`);
    const ipc = createServer(s => {
      let line = '';
      s.on('data', async chunk => {
        line += chunk;
        if (!line.includes('\n')) return;
        const q = JSON.parse(line);
        if (q.token !== bearer || q.v !== 1) return s.end('{"v":1,"ok":false}\n');
        calls.push(q.op === 'link' ? q.access : q.op);
        operations.push(q.op);
        if (q.op === 'snapshot' && nextSnapshot) {
          const pause = nextSnapshot;
          nextSnapshot = undefined;
          await pause();
        }
        const snapshot = { ...state, instanceId: instance, access: 'control',
          sessionName: null, cwd: '.', model: null, startedAt: 123, inputRequired: false, busy: false };
        events.emit('change');
        const secret = q.access === 'control' ? Buffer.concat([key, writer]) : key;
        const response = q.op === 'snapshot' ? { ok: true, snapshot } : q.generation === state.generation
          ? { ok: true, url: `http://127.0.0.1:${adapter.port}/#${state.linkOrigin}/r/${room}.${secret.toString('base64url')}` }
          : { ok: false, error: 'stale_generation' };
        s.end(JSON.stringify({ v: 1, ...response }) + '\n');
      });
      s.on('error', () => {});
    }).listen(endpoint);
    await once(ipc, 'listening');
    cleanup.push(async () => {
      const closed = once(ipc, 'close');
      ipc.close();
      await closed;
    });
    await writeFile(join(dir, `${id}.json`), JSON.stringify({ pid, version: 1, instanceId: instance, endpoint, token: bearer, createdAt: Date.now() }), { mode: 0o600 });
    return operations;
  }
  async function connect() {
    const ws = new WebSocket(`${origin}/r/${room}?role=host`);
    ws.binaryType = 'arraybuffer';
    const received: Received[] = [];
    ws.onmessage = ({ data }) => {
      if (typeof data === 'string') return;
      const e = unpackEnvelope(new Uint8Array(data))!;
      const p = e.payload, decrypt = createDecipheriv('aes-256-gcm', key, p.subarray(0, 12));
      decrypt.setAuthTag(p.subarray(-16));
      const text = Buffer.concat([decrypt.update(p.subarray(12, -16)), decrypt.final()]);
      received.push({ peer: e.peerId, frame: JSON.parse(text.toString()) });
      events.emit('change');
    };
    await once(ws, 'open');
    cleanup.push(() => { ws.close(); });
    function send(peer: number, frame: object) {
      const iv = randomBytes(12), encrypt = createCipheriv('aes-256-gcm', key, iv);
      ws.send(packEnvelope(peer, Buffer.concat([iv, encrypt.update(JSON.stringify(frame)), encrypt.final(), encrypt.getAuthTag()])));
    }
    async function hello(): Promise<ReceivedHello> {
      await until(() => received.length > 0);
      const { peer, frame } = received.shift()!;
      if (frame.t !== 'hello') throw new Error(`Expected hello, received ${frame.t}`);
      expect(frame.proto).toBe(COLLAB_PROTO);
      return { peer, frame };
    }
    function welcome(h: ReceivedHello, readOnly: boolean, id = session) {
      state.participants = 2;
      send(h.peer, { t: 'welcome', proto: COLLAB_PROTO, header: { type: 'session', id, cwd: '.', timestamp: '2026-01-01T00:00:00Z' },
        readOnly: readOnly || undefined, state: { cwd: '.', queuedMessageCount: 0, isStreaming: false,
          participants: [{ role: 'host', name: 'fixture' }, { role: 'guest', name: h.frame.name, readOnly: readOnly || undefined }] }, agents: [], entryCount: 0 });
    }
    async function authenticate() {
      const ro = await hello();
      expect(ro.frame.writeToken === undefined).toBe(true);
      welcome(ro, true);
      const rw = await hello();
      expect(rw.frame.writeToken === writer.toString('base64url')).toBe(true);
      welcome(rw, false);
      return rw.peer;
    }
    return { ws, received, send, hello, welcome, authenticate };
  }
  return { adapter, origin, state, calls, publish, connect, holdSnapshot, requests, ended, problems, lost: () => lost, ready: () => ready };
}

test('delayed publication, challenge, writer welcome, and one response per live dialog', async () => {
  const f = await fixture(), host = await f.connect();
  expect(f.ready()).toBe(0);
  await f.publish();
  const peer = await host.authenticate();
  await until(() => f.ready() === 1);
  host.send(peer, { t: 'snapshot-chunk', entries: [{ type: 'message' }], final: true });
  host.send(peer, { t: 'ui-request', request: { kind: 'editor', reqId: 73, title: 'private field' } });
  await until(() => f.requests.length === 1);
  const id = f.requests[0]!.reqId;
  expect(await f.adapter.reply(id, 'answer')).toBe(true);
  expect(await f.adapter.reply(id, 'again')).toBe(false);
  await until(() => host.received.length === 1);
  expect(host.received[0]).toEqual({ peer, frame: { t: 'ui-response', reqId: 73, value: 'answer' } });
  host.send(0, { t: 'ui-request-end', reqId: 73 });
  await until(() => f.ended.includes(id));
});

test.each(['session', 'pid', 'relay', 'generation', 'welcome'] as const)('never requests writer on incompatible %s', async mismatch => {
  const f = await fixture();
  if (mismatch === 'pid') f.state.pid++;
  if (mismatch === 'session') f.state.sessionId = 'unrelated';
  if (mismatch === 'relay') f.state.linkOrigin = 'wss://other.invalid';
  await f.publish();
  const host = await f.connect();
  if (mismatch === 'welcome' || mismatch === 'generation') {
    const h = await host.hello();
    if (mismatch === 'generation') f.state.generation++;
    host.welcome(h, true, mismatch === 'welcome' ? 'other-session' : session);
  }
  await until(() => f.problems.length > 0);
  expect(f.calls.includes('control')).toBe(false);
  expect(f.ready()).toBe(0);
  expect(f.problems.join(' ')).not.toContain('/r/');
});

test('a desktop win during an in-flight generation check cancels the outbound response', async () => {
  const f = await fixture();
  await f.publish();
  const host = await f.connect(), peer = await host.authenticate();
  host.send(peer, { t: 'ui-request', request: { reqId: 7, kind: 'editor', title: 'field' } });
  await until(() => f.requests.length === 1);
  const id = f.requests[0]!.reqId, check = f.holdSnapshot();
  const answer = f.adapter.reply(id, 'too late');
  await check.entered;
  host.send(peer, { t: 'ui-request-end', reqId: 7 });
  await until(() => f.ended.includes(id));
  check.release();
  expect(await answer).toBe(false);
  expect(host.received.length).toBe(0);
});

test('end and disconnect invalidate handles even if a reconnected host reuses its wire id', async () => {
  const f = await fixture();
  await f.publish();
  const a = await f.connect(), peer = await a.authenticate();
  const ask = { t: 'ui-request', request: { reqId: 1, kind: 'editor', title: 'field' } };
  a.send(peer, ask);
  await until(() => f.requests.length === 1);
  const old = f.requests[0]!.reqId;
  a.send(peer, { t: 'ui-request-end', reqId: 1 });
  await until(() => f.ended.includes(old));
  expect(await f.adapter.reply(old, 'late')).toBe(false);
  a.send(peer, { ...ask, request: { ...ask.request, reqId: 2 } });
  await until(() => f.requests.length === 2);
  const disconnected = f.requests[1]!.reqId;
  a.ws.close();
  await until(() => f.lost() > 0);
  f.state.relayConnected = false; // stock host holds reconnects provisional before resetting peers
  const previous = f.calls.length, b = await f.connect();
  await until(() => f.calls.length > previous);
  f.state.participants = 1;
  f.state.relayConnected = true;
  const peerB = await b.authenticate();
  b.send(peerB, { ...ask, request: { ...ask.request, reqId: 2 } });
  await until(() => f.requests.length === 3);
  expect(await f.adapter.reply(disconnected, 'stale')).toBe(false);
  expect(await f.adapter.reply(f.requests[2]!.reqId, 'current')).toBe(true);
  await until(() => b.received.length === 1);
  expect(b.received[0]!.frame).toEqual({ t: 'ui-response', reqId: 2, value: 'current' });
});

test('no public guest route and a second host cannot displace the first', async () => {
  const f = await fixture();
  const first = await f.connect();
  async function rejected(role: string) {
    const ws = new WebSocket(`${f.origin}/r/${room}?role=${role}`);
    const result = Promise.withResolvers<boolean>();
    ws.onopen = () => result.resolve(false);
    ws.onerror = ws.onclose = () => result.resolve(true);
    try { return await result.promise; } finally { ws.close(); }
  }
  expect(await rejected('guest')).toBe(true);
  expect(await rejected('host')).toBe(true);
  expect(first.ws.readyState).toBe(WebSocket.OPEN);
  await f.publish();
  await first.authenticate();
  await until(() => f.ready() === 1);
});

test('does not connect to another process’s registry endpoint, even for the same instance id', async () => {
  const f = await fixture();
  const unrelated = await f.publish(process.pid + 1);
  await f.publish();
  const host = await f.connect();
  await host.authenticate();
  await until(() => f.ready() === 1);
  expect(unrelated).toEqual([]);
});
