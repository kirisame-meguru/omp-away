import { spawn } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { Framer, frame, isRoute as route, mediaPacket, readMedia } from './framing';
import { preferences, preferencePatch, type Preferences } from '../decisions/preferences';

export type PhoneControl =
  | { type: 'list' }
  | { type: 'join'; requestId: string; captions?: boolean }
  | { type: 'silence' | 'hangup'; requestId: string }
  | { type: 'played'; requestId: string; mark: string };
export type DesktopControl =
  | { type: 'inbox'; items: { requestId: string; project: string; question: string; createdAt: number }[] }
  | { type: 'joined' | 'ended'; requestId: string }
  | { type: 'mark'; requestId: string; mark: string }
  | { type: 'transcript'; requestId: string; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'error'; code: string };

export interface SecureDesktopOptions {
  url: string;
  desktopToken: string;
  /** Dedicated private directory. A pre-existing permissive directory is rejected. */
  stateDir: string;
  /** Python environment with the installed omp-away-tunnel package. */
  python?: string;
  confirmPair(deviceId: string, emoji: string): Promise<boolean>;
  onMessage(deviceId: string, message: PhoneControl): void;
  onPcm(deviceId: string, pcm: Uint8Array): void;
  onLoss(deviceId: string): void;
  onConnect?(deviceId: string): void;
  onError?(code: string): void;
  onRouting?(next: Preferences): void;
}

export interface SecureDesktop {
  /** Fresh, sensitive, serialized Away/1 QR payload. Never log it. */
  pair(): Promise<string>;
  devices(): Promise<string[]>;
  routing(patch?: Partial<Preferences>): Promise<Preferences>;
  ring(deviceId: string, requestId: string): Promise<void>;
  sendControl(deviceId: string, message: DesktopControl): Promise<void>;
  sendPcm(deviceId: string, pcm: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

const digest = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x) && Buffer.from(x, 'base64url').toString('base64url') === x;
const emoji = /^[🐶🐱🦊🐻🐼🐸🐵🐯🦁🐷🐨🐰🐙🐧🐳🐢]{12}$/u;
const decoder = new TextDecoder('utf-8', { fatal: true });
const jsonFrame = (value: unknown) => frame(1, Buffer.from(JSON.stringify(value)));

function helperEnv(): NodeJS.ProcessEnv {
  // Whitelist only OS/runtime paths. No Codex login, proxy, TLS overrides, Python
  // module injection, cloud credentials or parent application environment.
  const vars: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'SystemDrive', 'LANG']) {
    if (process.env[k] !== undefined) vars[k] = process.env[k];
  }
  return vars;
}

export async function startSecureDesktop(opts: SecureDesktopOptions): Promise<SecureDesktop> {
  const origin = new URL(opts.url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || (opts.url !== origin.origin && opts.url !== `${origin.origin}/`)) {
    throw new Error('Expected a credential-free HTTPS relay origin');
  }
  if (!isAbsolute(opts.stateDir) || !digest(opts.desktopToken)) throw new Error('Invalid secure desktop configuration');
  const requested = opts.python ?? (process.platform === 'win32' ? 'python' : 'python3');
  const searchPath = (process.env.PATH ?? '').split(delimiter).filter(dir => isAbsolute(dir)).join(delimiter);
  const executable = isAbsolute(requested) ? requested : Bun.which(requested, {cwd: import.meta.dir, PATH: searchPath});
  if (!executable || !isAbsolute(executable)) throw new Error('Secure helper Python executable not found');
  const child = spawn(executable, ['-I', '-m', 'omp_away_tunnel'], {
    cwd: import.meta.dir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: helperEnv(),
  });
  let closing = false, stopped = false, seq = 0;
  let routingVersion = 0, routingReceived = false;
  const connected = new Map<string, string>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  function notice(code: string) {
    try { opts.onError?.(code); } catch { /* The error callback must not prevent cleanup. */ }
  }
  function stop(code: string) {
    if (stopped) return;
    stopped = true;
    const err = new Error(code);
    ready.reject(err);
    for (const rpc of pending.values()) { clearTimeout(rpc.timer); rpc.reject(err); }
    pending.clear();
    for (const device of connected.keys()) {
      try { void Promise.resolve(opts.onLoss(device)).catch(() => notice('callback_failed')); } catch { notice('callback_failed'); }
    }
    connected.clear();
    if (!closing) notice(code);
    child.kill();
  }
  child.once('error', () => stop('secure_helper_launch_failed'));
  child.once('close', () => { stop('secure_helper_closed'); exited.resolve(); });
  child.stdin.on('error', () => stop('secure_helper_pipe_failed'));
  child.stdout.on('error', () => stop('secure_helper_pipe_failed'));

  async function rpc(payload: (id: number) => Buffer): Promise<unknown> {
    if (closing || stopped) return Promise.reject(new Error('Secure channel is closed'));
    if (pending.size >= 128) return Promise.reject(new Error('Secure channel backpressure'));
    seq = seq === 0xffffffff ? 1 : seq + 1;
    const id = seq;
    const bytes = payload(id);
    const {resolve, reject, promise} = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => stop('secure_helper_timeout'), 30_000);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(bytes, err => { if (err) stop('secure_helper_pipe_failed'); });
    return promise;
  }
  function command(op: string, fields: Record<string, unknown> = {}) {
    return rpc(id => jsonFrame({op, id, ...fields}));
  }
  async function routing(patch?: Partial<Preferences>): Promise<Preferences> {
    if (routingVersion !== 1) throw new Error('shared-routing-upgrade-required');
    return preferences(await command('routing', patch === undefined ? {} : {patch: preferencePatch(patch)}));
  }
  function requireConnected(deviceId: string) {
    const ref = connected.get(deviceId);
    if (!ref) throw new Error('No authenticated tunnel');
    return ref;
  }
  function deliver(callback: () => void) {
    try { void Promise.resolve(callback()).catch(() => stop('secure_callback_failed')); }
    catch { stop('secure_callback_failed'); }
  }
  const parser = new Framer((kind, data) => {
    if (stopped || closing) return;
    if (kind === 2) {
      const pkt = readMedia(data);
      if (pkt.id !== 0 || requireConnected(pkt.deviceId) !== pkt.ref) throw new Error('Unexpected media correlation');
      deliver(() => opts.onPcm(pkt.deviceId, pkt.pcm));
      return;
    }
    const msg = JSON.parse(decoder.decode(data));
    switch (msg.event) {
      case 'ready': routingVersion = msg.routingVersion; ready.resolve(); return;
      case 'routing': {
        const next = preferences(msg.preferences);
        routingReceived = true;
        deliver(() => opts.onRouting?.(next));
        return;
      }
      case 'fatal': stop(route(msg.code) ? msg.code : 'secure_helper_failed'); return;
      case 'error': notice(route(msg.code) ? msg.code : 'secure_helper_failed'); return;
      case 'reply': {
        const request = pending.get(msg.id);
        if (!request) throw new Error('Unknown secure helper response');
        pending.delete(msg.id);
        clearTimeout(request.timer);
        if (msg.ok === true) request.resolve(msg.value);
        else request.reject(new Error('Secure channel operation rejected'));
        return;
      }
    }
    const deviceId = msg.deviceId;
    if (!route(deviceId)) throw new Error('Invalid device route');
    switch (msg.event) {
      case 'confirm': {
        if (!route(msg.ref) || typeof msg.emoji !== 'string' || !emoji.test(msg.emoji)) throw new Error('Invalid pairing confirmation');
        void Promise.resolve().then(() => opts.confirmPair(deviceId, msg.emoji)).catch(() => false)
          .then(accept => command('confirm', {ref: msg.ref, accept: accept === true})).catch(() => { if (!closing && !stopped) stop('confirmation_failed'); });
        return;
      }
      case 'connected':
        if (connected.has(deviceId) || typeof msg.ref !== 'string' || !/^[a-f0-9]{32}$/.test(msg.ref)) throw new Error('Invalid authenticated tunnel');
        connected.set(deviceId, msg.ref); deliver(() => opts.onConnect?.(deviceId)); return;
      case 'lost':
        if (requireConnected(deviceId) !== msg.ref) throw new Error('Stale secure helper event');
        connected.delete(deviceId); deliver(() => opts.onLoss(deviceId)); return;
      case 'message':
        if (requireConnected(deviceId) !== msg.ref) throw new Error('Stale secure helper message');
        deliver(() => opts.onMessage(deviceId, msg.message)); return;
      default: throw new Error('Unknown secure helper event');
    }
  });
  child.stdout.on('data', (chunk: Buffer) => { try { parser.push(chunk); } catch { stop('secure_helper_protocol_error'); } });
  child.stdout.on('end', () => { try { parser.end(); } catch { stop('secure_helper_protocol_error'); } });
  const startup = setTimeout(() => stop('secure_helper_start_timeout'), 25_000);
  try {
    child.stdin.write(jsonFrame({op:'start', url:origin.origin, desktopToken:opts.desktopToken, stateDir:opts.stateDir}));
    await ready.promise;
    if (opts.onRouting) {
      await routing();
      if (!routingReceived || stopped) throw new Error('shared-routing-snapshot-unavailable');
    }
  } catch (err) {
    stop('secure_helper_failed');
    throw err;
  } finally { clearTimeout(startup); }
  return {
    routing,
    async pair() {
      const qr = await command('pair') as Record<string, unknown>;
      if (qr?.v !== 1 || qr.url !== origin.origin || !route(qr.ticket) || !digest(qr.desktopPin) || !digest(qr.nonce) || !digest(qr.secret)) throw new Error('Invalid pairing payload');
      return JSON.stringify({v:1, url:qr.url, ticket:qr.ticket, desktopPin:qr.desktopPin, nonce:qr.nonce, secret:qr.secret});
    },
    async devices() {
      const result = await command('devices');
      if (!Array.isArray(result) || !result.every(route)) throw new Error('Invalid registered devices');
      return result as string[];
    },
    async ring(deviceId, requestId) {
      if (!route(deviceId) || !route(requestId)) throw new Error('Invalid invite route');
      await command('ring', {deviceId, requestId});
    },
    async sendControl(deviceId, message) { await command('control', {deviceId, ref: requireConnected(deviceId), message}); },
    async sendPcm(deviceId, pcm) {
      const ref = requireConnected(deviceId);
      await rpc(id => frame(2, mediaPacket(id, deviceId, ref, pcm)));
    },
    async close() {
      if (!closing && !stopped) {
        closing = true;
        child.stdin.end(jsonFrame({op:'close'}));
      }
      const timer = setTimeout(() => stop('secure_helper_close_timeout'), 2000);
      try { await exited.promise; } finally { clearTimeout(timer); }
    },
  };
}
