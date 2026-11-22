const PCM = 960;
const routePattern = /^[A-Za-z0-9_-]{1,128}$/;

function check(kind: number, size: number): void {
  if (!(kind === 1 && size > 0 && size <= 131072 || kind === 2 && size >= PCM + 22 && size <= PCM + 149)) {
    throw new Error('Invalid secure helper frame');
  }
}

export function frame(kind: number, data: Uint8Array): Buffer {
  check(kind, data.length);
  const out = Buffer.allocUnsafe(5 + data.length);
  out[0] = kind;
  out.writeUInt32BE(data.length, 1);
  out.set(data, 5);
  return out;
}

export function mediaPacket(id: number, deviceId: string, ref: string, pcm: Uint8Array): Buffer {
  if (!routePattern.test(deviceId) || !/^[a-f0-9]{32}$/.test(ref) || pcm.length !== PCM) throw new Error('Invalid media packet');
  const body = Buffer.allocUnsafe(21 + deviceId.length + PCM);
  body.writeUInt32BE(id);
  body[4] = deviceId.length;
  body.write(deviceId, 5, deviceId.length, 'ascii');
  body.write(ref, 5 + deviceId.length, 16, 'hex');
  body.set(pcm, 21 + deviceId.length);
  return body;
}

export function readMedia(data: Uint8Array): {id: number; deviceId: string; ref: string; pcm: Uint8Array} {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const n = view[4];
  const deviceId = view.toString('latin1', 5, 5 + n);
  if (!routePattern.test(deviceId) || data.length !== 21 + n + PCM) throw new Error('Invalid media route');
  return {id: view.readUInt32BE(0), deviceId, ref: view.toString('hex', 5 + n, 21 + n), pcm: view.subarray(21 + n)};
}

export class Framer {
  private readonly header = Buffer.allocUnsafe(5);
  private offset = 0;
  private body?: Buffer;
  constructor(private readonly receive: (kind: number, data: Uint8Array) => void) {}

  push(chunk: Uint8Array): void {
    let pos = 0;
    while (pos < chunk.length) {
      const target = this.body ?? this.header;
      const count = Math.min(chunk.length - pos, target.length - this.offset);
      target.set(chunk.subarray(pos, pos + count), this.offset);
      this.offset += count;
      pos += count;
      if (this.offset !== target.length) continue;
      this.offset = 0;
      if (this.body) {
        this.body = undefined;
        this.receive(this.header[0], target);
      } else {
        const n = this.header.readUInt32BE(1);
        check(this.header[0], n);
        this.body = Buffer.allocUnsafe(n);
      }
    }
  }

  end(): void {
    if (this.body || this.offset) throw new Error('Truncated secure helper frame');
  }
}
