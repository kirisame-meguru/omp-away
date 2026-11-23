import { describe, expect, it } from 'bun:test';
import { Framer, frame, mediaPacket, readMedia } from '../src/secure-channel/framing';
import { startSecureDesktop } from '../src/secure-channel';

describe('private helper boundary', () => {
  it('preserves adjacent fragmented control and binary audio without JSON/base64 conversion', () => {
    const control = new TextEncoder().encode('{"event":"ready"}');
    const pcm = Uint8Array.from({ length: 960 }, (_, i) => i & 255);
    const ref = 'fade'.repeat(8);
    const bytes = Buffer.concat([frame(1, control), frame(2, mediaPacket(123, 'route-1', ref, pcm))]);
    const received: [number, Uint8Array][] = [];
    const parser = new Framer((k, v) => received.push([k, v]));
    for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
    parser.end();
    expect(received.length).toBe(2);
    expect(received[0][0]).toBe(1);
    expect(new TextDecoder().decode(received[0][1])).toBe('{"event":"ready"}');
    const media = readMedia(received[1][1]);
    expect(media.id).toBe(123);
    expect(media.deviceId).toBe('route-1');
    expect(media.ref).toBe(ref);
    expect(Array.from(media.pcm)).toEqual(Array.from(pcm));
  });
  it('rejects unknown kinds, oversized headers and partial EOF', () => {
    for (const header of [[3, 0, 0, 0, 1], [1, 0, 2, 0, 1], [2, 0, 4, 0, 0]]) {
      expect(() => new Framer(() => {}).push(Uint8Array.from(header))).toThrow();
    }
    const parser = new Framer(() => {});
    parser.push(Uint8Array.of(1, 0, 0));
    expect(() => parser.end()).toThrow();
  });
  it('rejects non-HTTPS, credential-bearing and off-origin URLs before spawning', async () => {
    for (const url of ['http://away.example.invalid', 'https://name:password@example.org', 'https://example.org/private?token=x']) {
      await expect(startSecureDesktop({url, desktopToken:'A'.repeat(43), stateDir:'/unused',confirmPair:async()=>false,onMessage(){},onPcm(){},onLoss(){}})).rejects.toThrow();
    }
  });
});
