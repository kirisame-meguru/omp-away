import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from '@oh-my-pi/pi-wire';

// Registry v1: one authenticated JSON line per local IPC connection. In particular,
// never use `collab link <pid>`: it re-lists and might select a newer generation.
interface Publication { instanceId: string; endpoint: string; token: string }
export interface LocalRoom {
  readonly generation: number;
  readonly viewKey: Buffer;
  writer(signal: AbortSignal): Promise<string>;
  current(signal: AbortSignal): Promise<void>;
}

const denied = () => new Error('Local Collab publication is incompatible or no longer current.');
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const owned = (mode: number, uid: number) => process.platform === 'win32' || (uid === process.geteuid?.() && (mode & 0o077) === 0);

// Constrain even malformed metadata to the local IPC namespace. Match the native
// endpoint derivation, including relocated long POSIX paths (never a remote pipe).
function endpointFor(dir: string, id: string): string {
  const hash = (value: string) => Bun.hash.xxHash64(value).toString(16).padStart(16, '0');
  if (process.platform === 'win32') return `\\\\.\\pipe\\omp-${id}-${hash(dir.toLowerCase())}`;
  const path = join(dir, `${id}.sock`);
  return Buffer.byteLength(path) < (process.platform === 'linux' || process.platform === 'android' ? 108 : 104)
    ? path : `/tmp/omp-${process.geteuid?.()}/${hash(`${dir}\0${id}`)}.sock`;
}

async function publications(dir: string): Promise<Publication[]> {
  let names: string[];
  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || !owned(st.mode, st.uid)) throw denied();
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw denied();
  }
  const matches: Publication[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
    const path = join(dir, name);
    let data: unknown;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || !owned(stat.mode, stat.uid) || stat.size > 4096) continue;
      const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      try { data = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    } catch { continue; } // An unrelated or just-withdrawn publication.
    if (!object(data) || data.pid !== process.pid) continue;
    if (data.version !== 1 || typeof data.instanceId !== 'string' || !/^[a-z0-9-]{8,64}$/.test(data.instanceId)
      || typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)
      || typeof data.endpoint !== 'string' || data.endpoint !== endpointFor(dir, name.slice(0, -5))) throw denied();
    matches.push({ instanceId: data.instanceId, token: data.token, endpoint: data.endpoint });
  }
  return matches;
}

async function query(p: Publication, op: object, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const socket = createConnection({ path: p.endpoint, signal });
  const deadline = setTimeout(() => reject(denied()), 1500);
  const chunks: Buffer[] = [];
  let size = 0;
  socket.once('connect', () => socket.write(JSON.stringify({ v: 1, token: p.token, ...op }) + '\n'));
  socket.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 65536) { reject(denied()); socket.destroy(); return; }
    const lf = chunk.indexOf(10);
    chunks.push(lf === -1 ? chunk : chunk.subarray(0, lf));
    if (lf === -1) return;
    try {
      const response: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(response) || response.ok !== true || response.v !== 1) throw denied();
      resolve(response);
    } catch { reject(denied()); }
  });
  socket.on('error', () => reject(denied()));
  socket.once('close', () => reject(denied()));
  try { return await promise; } finally { clearTimeout(deadline); socket.destroy(); }
}

async function snapshot(p: Publication, session: string, signal: AbortSignal) {
  const { snapshot: s } = await query(p, { op: 'snapshot' }, signal);
  if (!object(s) || s.pid !== process.pid || s.instanceId !== p.instanceId || s.sessionId !== session
    || s.access !== 'control' || typeof s.relayConnected !== 'boolean' || typeof s.generation !== 'number'
    || !Number.isSafeInteger(s.generation) || s.generation < 1) throw denied();
  return { generation: s.generation, participants: s.participants, connected: s.relayConnected };
}

async function link(p: Publication, generation: number, target: string, access: 'view' | 'control', signal: AbortSignal) {
  const { url } = await query(p, { op: 'link', generation, access }, signal);
  // The browser shell may be hosted separately; it is never opened. Only the
  // exact ws://127.0.0.1:<bound port>/r/<connected room> inner target is valid.
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw denied();
  const fragment = url.indexOf('#');
  if (fragment < 0 || !url.startsWith(target + '.', fragment + 1)) throw denied();
  const raw = url.slice(fragment + target.length + 2);
  const bytes = access === 'view' ? ROOM_KEY_BYTES : ROOM_KEY_BYTES + WRITE_TOKEN_BYTES;
  if (raw.length !== Math.ceil(bytes * 4 / 3) || !/^[a-zA-Z0-9_-]+$/.test(raw)) throw denied();
  const secret = Buffer.from(raw, 'base64url');
  if (secret.length !== bytes || secret.toString('base64url') !== raw) throw denied();
  return secret;
}

export async function discoverLocalRoom(port: number, roomId: string, session: string, signal: AbortSignal): Promise<LocalRoom> {
  const dir = join(homedir(), process.env.PI_CONFIG_DIR || '.omp', 'run', 'collab-hosts');
  const target = new URL(`/r/${roomId}`, `ws://127.0.0.1:${port}`).href;
  for (;;) {
    signal.throwIfAborted();
    const entries = await publications(dir);
    if (entries.length > 1) throw denied();
    const entry = entries[0];
    if (!entry) { await delay(100, undefined, { signal }); continue; }
    const { generation, participants, connected } = await snapshot(entry, session, signal);
    // A reclaiming upstream host briefly keeps its old roster and reports offline
    // before it commits the new WebSocket; it must not be challenged until then.
    if (!connected) { await delay(100, undefined, { signal }); continue; }
    if (participants !== 1) throw denied(); // There must be no pre-existing guest.
    const viewKey = await link(entry, generation, target, 'view', signal);
    // Keep the exact publication endpoint and generation. A rotated room never
    // obtains the previous proof and a concurrent session switch fails closed.
    const current = async (s: AbortSignal) => {
      const now = await snapshot(entry, session, s);
      if (!now.connected || now.generation !== generation || now.participants !== 2) throw denied();
    };
    return { generation, viewKey, current, async writer(s) {
      await current(s); // the read-only peer has joined this very publication
      const secret = await link(entry, generation, target, 'control', s);
      try {
        if (!secret.subarray(0, ROOM_KEY_BYTES).equals(viewKey)) throw denied();
        return secret.subarray(ROOM_KEY_BYTES).toString('base64url');
      } finally { secret.fill(0); }
    } };
  }
}
