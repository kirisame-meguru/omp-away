// Test-only Frida agent. Never load this into a normal user call.
'use strict';

let app = '';
for (const byte of new Uint8Array(File.readAllBytes('/proc/self/cmdline'))) {
  if (byte === 0) break;
  app += String.fromCharCode(byte);
}
if (app !== 'ru.eleven.ompaway' && app !== 'ru.eleven.ompaway.integration') {
  throw new Error('Refusing to instrument a non-Away process');
}
const audio = Process.getModuleByName('libaudioclient.so');
const read = audio.getExportByName('_ZN7android11AudioRecord4readEPvmb');
const write = audio.getExportByName('_ZN7android10AudioTrack5writeEPKvmb');
const silence = new Uint8Array(65536);
const stats = { reads: 0, microphoneBytes: 0, injectedBytes: 0, playbackBytes: 0 };
let clip = null;
let offset = 0;
let label = '';

function receive() {
  recv('pcm', (message, data) => {
    if (clip !== null || data === null || data.byteLength === 0 ||
        data.byteLength > 24000 * 2 * 60 || data.byteLength % 2 !== 0) {
      send({ kind: 'rejected', id: message.id, reason: 'busy-or-invalid-pcm' });
    } else {
      clip = new Uint8Array(data);
      offset = 0;
      label = message.id;
      send({ kind: 'queued', id: label, bytes: clip.length });
    }
    receive();
  });
}
receive();

Interceptor.attach(read, {
  onEnter(args) { this.buffer = args[1]; },
  onLeave(result) {
    const count = result.toInt32();
    if (count <= 0) return;
    if (count > silence.length) {
      // Fail closed instead of forwarding an unexpected ambient microphone buffer.
      result.replace(-3);
      send({ kind: 'error', reason: 'microphone-buffer-too-large' });
      return;
    }
    stats.reads++;
    stats.microphoneBytes += count;
    const available = clip === null ? 0 : Math.min(count, clip.length - offset);
    if (available === count) {
      this.buffer.writeByteArray(clip.subarray(offset, offset + count));
    } else {
      this.buffer.writeByteArray(silence.subarray(0, count));
      if (available) this.buffer.writeByteArray(clip.subarray(offset, offset + available));
    }
    if (available) {
      offset += available;
      stats.injectedBytes += available;
      if (offset === clip.length) {
        send({ kind: 'consumed', id: label, bytes: offset });
        clip = null;
        offset = 0;
      }
    }
  },
});

Interceptor.attach(write, {
  onEnter(args) { this.buffer = args[1]; },
  onLeave(result) {
    const count = result.toInt32();
    if (count <= 0) return;
    if (count > silence.length) {
      send({ kind: 'error', reason: 'playback-buffer-too-large' });
      return;
    }
    // Observe only bytes the real AudioTrack accepted; do not replace output or acknowledgements.
    stats.playbackBytes += count;
    send({ kind: 'playback', bytes: count, at: Date.now() }, this.buffer.readByteArray(count));
  },
});
setInterval(() => send({ kind: 'stats', ...stats, queuedBytes: clip === null ? 0 : clip.length - offset }), 1000);
send({ kind: 'ready', pid: Process.id, sampleRate: 24000, channels: 1, sampleBytes: 2 });
