import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { COLLAB_PROTO, packEnvelope, unpackEnvelope, type CollabUiRequest, type GuestFrame, type HostFrame } from '@oh-my-pi/pi-wire';
import { discoverLocalRoom, type LocalRoom } from './discovery';

interface Callbacks {
  request(request: CollabUiRequest): void;
  end(reqId: number): void;
  lost(): void;
  ready?(): void;
  unavailable?(reason: string): void;
}
export interface Adapter {
  readonly port: number;
  reply(reqId: number, value: string): Promise<boolean>;
  close(): Promise<void>;
}
interface Ticket { local: number; wire: number; submitted: boolean }
type HostSocket = Bun.ServerWebSocket<{ roomId: string }>;
interface Connection {
  ws: HostSocket;
  abort: AbortController;
  timeout: Timer;
  phase: 'discovery' | 'view' | 'acquiring' | 'writer' | 'ready';
  guest: string;
  room?: LocalRoom;
  byWire: Map<number, Ticket>;
  byLocal: Map<number, Ticket>;
}

// There is no general-purpose guest socket and there is no send-frame API. This
// sole virtual peer can emit exactly these two frame types, to the accepted host.
const peer = 1;
function send(c: Connection, frame: Extract<GuestFrame, { t: 'hello' | 'ui-response' }>): boolean {
  if (!c.room || c.abort.signal.aborted) return false;
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', c.room.viewKey, iv);
  const sealed = Buffer.concat([iv, cipher.update(JSON.stringify(frame)), cipher.final(), cipher.getAuthTag()]);
  return c.ws.send(packEnvelope(peer, sealed)) !== 0;
}

function decrypt(key: Buffer, sealed: Uint8Array): HostFrame | undefined {
  if (sealed.length < 28) throw new Error('Malformed sealed frame');
  const cipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  cipher.setAuthTag(sealed.subarray(-16));
  const bytes = cipher.update(sealed.subarray(12, -16));
  cipher.final(); // authenticate before inspecting plaintext; GCM emits no final bytes
  // Stock omp emits the discriminator first. Skip large replica payloads without
  // constructing strings or objects for their contents. Nothing is persisted.
  if (/^\{"t":"(?:snapshot-chunk|entry|event|state|agents|bus|transcript)",/.test(bytes.toString('utf8', 0, 24))) return;
  return JSON.parse(bytes.toString('utf8')) as HostFrame;
}

function supported(r: CollabUiRequest | undefined): r is CollabUiRequest {
  if (!r || typeof r.title !== 'string' || !Number.isSafeInteger(r.reqId) || r.reqId < 1) return false;
  if (r.kind === 'editor') return r.prefill === undefined || typeof r.prefill === 'string';
  return r.kind === 'select' && (r.approval === undefined || r.approval === false) && Array.isArray(r.options)
    && r.options.every(o => typeof o === 'string' || (o && typeof o === 'object' && typeof o.label === 'string'));
}

export async function startAdapter(port: number, sessionId: string, callbacks: Callbacks): Promise<Adapter> {
  if (!sessionId || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local Collab configuration.');
  let host: Connection | undefined;
  let reserved = false, closed = false, nextId = 1;
  let absent: Timer;

  function drop(c: Connection) {
    if (host !== c) return;
    host = undefined;
    reserved = false;
    clearTimeout(c.timeout);
    c.abort.abort();
    c.room?.viewKey.fill(0);
    c.byLocal.clear();
    c.byWire.clear();
    callbacks.lost();
  }
  function refuse(c: Connection) {
    if (host !== c) return;
    drop(c);
    c.ws.close(1012, 'local collaboration unavailable');
    callbacks.unavailable?.('The local Collab room did not prove the expected session, generation and writer access.');
  }
  async function start(c: Connection) {
    try {
      const room = await discoverLocalRoom(server.port!, c.ws.data.roomId, sessionId, c.abort.signal);
      if (host !== c) { room.viewKey.fill(0); return; }
      c.room = room;
      c.phase = 'view';
      if (c.ws.send(JSON.stringify({ t: 'peer-joined', peer })) === 0 ||
        !send(c, { t: 'hello', proto: COLLAB_PROTO, name: c.guest })) refuse(c);
    } catch { refuse(c); }
  }
  async function upgradeWriter(c: Connection) {
    try {
      const writeToken = await c.room!.writer(c.abort.signal);
      if (host !== c) return;
      c.phase = 'writer';
      if (!send(c, { t: 'hello', proto: COLLAB_PROTO, name: c.guest, writeToken })) refuse(c);
    } catch { refuse(c); }
  }
  function receive(c: Connection, data: string | Buffer) {
    if (typeof data === 'string' || !c.room) return;
    const packet = unpackEnvelope(data);
    if (!packet || (packet.peerId !== peer && packet.peerId !== 0)) return;
    const frame = decrypt(c.room.viewKey, packet.payload);
    if (!frame) return;
    if (frame.t === 'bye' || frame.t === 'error') { refuse(c); return; }
    if (frame.t === 'welcome') {
      const checking = c.phase === 'view';
      const participants = frame.state?.participants;
      if (packet.peerId !== peer || (!checking && c.phase !== 'writer') || frame.proto !== COLLAB_PROTO
        || frame.header?.id !== sessionId || (frame.readOnly ?? false) !== checking || !Array.isArray(participants)
        || participants.length !== 2 || !participants.some(p => p.role === 'host')
        || !participants.some(p => p.role === 'guest' && p.name === c.guest && (p.readOnly ?? false) === checking)) {
        refuse(c); return;
      }
      if (checking) {
        c.phase = 'acquiring';
        void upgradeWriter(c);
      } else {
        c.phase = 'ready';
        clearTimeout(c.timeout);
        callbacks.ready?.();
      }
      return;
    }
    if (c.phase !== 'ready') return;
    if (frame.t === 'ui-request' && packet.peerId === peer && supported(frame.request)) {
      const wire = frame.request.reqId;
      if (c.byWire.has(wire) || c.byWire.size >= 64) { refuse(c); return; }
      // Wire ids can start at 1 again in a replacement room. Expose handles
      // that never alias another dialog during this adapter's lifetime.
      const ticket = { local: nextId++, wire, submitted: false };
      c.byLocal.set(ticket.local, ticket);
      c.byWire.set(wire, ticket);
      callbacks.request({ ...frame.request, reqId: ticket.local });
    } else if (frame.t === 'ui-request-end') {
      const ticket = c.byWire.get(frame.reqId);
      if (!ticket) return;
      c.byWire.delete(ticket.wire);
      c.byLocal.delete(ticket.local);
      callbacks.end(ticket.local);
    }
  }

  const bind = (listenPort:number) => Bun.serve<{ roomId: string }>({
    hostname: '127.0.0.1', port:listenPort, development: false, reusePort: false,
    fetch(req, srv) {
      const url = new URL(req.url), match = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname);
      // No guest upgrades, HTTP control endpoint, browser origins or DNS aliases.
      const authority = srv.port === 80 ? '127.0.0.1' : `127.0.0.1:${srv.port}`;
      if (req.method !== 'GET' || req.headers.has('origin') || req.headers.get('host') !== authority
        || !match || url.search !== '?role=host') return new Response(null, { status: 404 });
      if (closed || reserved) return new Response(null, { status: 409 });
      reserved = true;
      if (srv.upgrade(req, { data: { roomId: match[1]! } })) return;
      reserved = false;
      return new Response(null, { status: 426 });
    },
    websocket: {
      idleTimeout: 0,
      open(ws) {
        clearTimeout(absent);
        const c: Connection = { ws, abort: new AbortController(), phase: 'discovery',
          guest: `Away-${randomBytes(12).toString('hex')}`, byWire: new Map(), byLocal: new Map(),
          timeout: setTimeout(() => refuse(c), 15000).unref() };
        host = c;
        void start(c);
      },
      message(ws, data) {
        const c = host;
        if (!c || c.ws !== ws) return;
        try { receive(c, data); } catch { refuse(c); }
      },
      close(ws) { if (host && host.ws === ws) drop(host); },
    },
  });
  let server:Bun.Server<{roomId:string}>;
  try { server=bind(port); }
  catch(error) {
    if (!port || !(error instanceof Error) || !('code' in error) || error.code!=='EADDRINUSE') throw error;
    server=bind(0);
  }
  absent = setTimeout(() => {
    if (!closed && !host) callbacks.unavailable?.('No local Collab host connected. Check the loopback relay and control auto-start settings.');
  }, 15000).unref();
  return {
    port: server.port!,
    async reply(id, value) {
      const c = host, ticket = c?.byLocal.get(id);
      if (!c?.room || c.phase !== 'ready' || !ticket || ticket.submitted || typeof value !== 'string') return false;
      ticket.submitted = true;
      try {
        await c.room.current(c.abort.signal);
        // The host can end the request while the generation check is in flight.
        if (c !== host || c.byLocal.get(id) !== ticket) return false;
        if (send(c, { t: 'ui-response', reqId: ticket.wire, value })) return true; // queued, not a native win
      } catch { /* Never propagate credential-bearing transport errors. */ }
      refuse(c);
      return false;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(absent);
      if (host) { const c = host; drop(c); c.ws.close(1001, 'adapter closed'); }
      await server.stop(true);
    },
  };
}
