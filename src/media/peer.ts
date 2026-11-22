import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../media/', import.meta.url));
const JSON_KIND = 1, PCM = 2, FRAME = 960, MAX_JSON = 65536;
const headerLength = 5;

export interface MediaPeer {
	offer: Promise<string>;
	answer(sdp: string): Promise<void>;
	sendPcm(pcm: Uint8Array): void;
	close(): Promise<void>;
}

/** The only spawned executable is the plugin's preprovisioned media venv. No command shell,
 * uv sync, inherited environment, credentials, cwd of the Ask or user-selected interpreter. */
export function spawnPeer(onAudio: (pcm: Uint8Array) => void, onFailure: () => void): MediaPeer {
	const win = process.platform === 'win32';
	const python = join(DIR, '.venv', ...(win ? ['Scripts', 'python.exe'] : ['bin', 'python']));
	const env: NodeJS.ProcessEnv = {};
	if (win && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
	const child = spawn(python, ['-I', '-u', join(DIR, 'peer.py')], {
		cwd: DIR, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
	});
	const offer = Promise.withResolvers<string>(), ready = Promise.withResolvers<void>();
	// Failure or cancellation can precede the caller awaiting either stage.
	void offer.promise.catch(() => {}); void ready.promise.catch(() => {});
	let phase: 'offer' | 'answer' | 'connecting' | 'ready' | 'closed' = 'offer';
	let ended = false;
	const exited = Promise.withResolvers<void>();
	function close() {
		if (phase !== 'closed') {
			phase = 'closed'; const error = new Error('Desktop media peer unavailable; provision the media virtual environment.');
			offer.reject(error); ready.reject(error);
			child.stdin.destroy(); child.stdout.destroy(); if (!ended) child.kill();
		}
		return exited.promise;
	}
	function fail() {
		if (phase === 'closed') return;
		void close(); onFailure();
	}
	child.once('error', fail); child.stdin.on('error', fail); child.stdout.on('error', fail);
	child.once('close', () => { ended = true; exited.resolve(); fail() });
	const header = Buffer.allocUnsafe(headerLength);
	let n = 0, kind = 0, payload: Buffer | undefined, used = 0;
	function receive(data: Buffer) {
		if (kind === PCM) {
			if (phase !== 'connecting' && phase !== 'ready') throw new Error('Unexpected PCM');
			if (phase === 'ready') onAudio(data);
			return;
		}
		const msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
		if (phase === 'offer' && msg.type === 'offer' && typeof msg.sdp === 'string' && msg.sdp.startsWith('v=0')) {
			phase = 'answer'; offer.resolve(msg.sdp);
		} else if (phase === 'connecting' && msg.type === 'ready') {
			phase = 'ready'; ready.resolve();
		} else throw new Error('Unexpected supervisor frame');
	}
	child.stdout.on('data', (chunk: Buffer) => {
		try {
			for (let pos = 0; pos < chunk.length && phase !== 'closed';) {
				if (!payload) {
					const take = Math.min(chunk.length - pos, headerLength - n);
					chunk.copy(header, n, pos, pos + take); pos += take; n += take;
					if (n !== headerLength) continue;
					kind = header[0]; const size = header.readUInt32BE(1);
					if (!((kind === PCM && size === FRAME) || (kind === JSON_KIND && size > 0 && size <= MAX_JSON))) throw new Error('Invalid helper frame');
					payload = Buffer.allocUnsafe(size); used = 0; n = 0;
				}
				const take = Math.min(chunk.length - pos, payload.length - used);
				chunk.copy(payload, used, pos, pos + take); used += take; pos += take;
				if (used === payload.length) { const data = payload; payload = undefined; receive(data) }
			}
		} catch { fail() }
	});
	function send(kind: number, data: Uint8Array) {
		if (child.stdin.writableLength > FRAME * 10 || !child.stdin.writable) {
			fail(); throw new Error('Media peer stalled');
		}
		const frame = Buffer.allocUnsafe(headerLength + data.byteLength);
		frame[0] = kind; frame.writeUInt32BE(data.byteLength, 1); frame.set(data, headerLength);
		child.stdin.write(frame);
	}
	return {
		offer: offer.promise,
		async answer(sdp: string) {
			if (phase !== 'answer' || sdp.length > MAX_JSON) throw new Error('Invalid media answer');
			const data = Buffer.from(JSON.stringify({ type: 'answer', sdp }));
			if (data.length > MAX_JSON) throw new Error('Oversize media answer');
			phase = 'connecting'; send(JSON_KIND, data); await ready.promise;
		},
		sendPcm(pcm: Uint8Array) {
			if (phase !== 'ready' || pcm.byteLength !== FRAME) throw new Error('Unexpected media input');
			send(PCM, pcm);
		}, close,
	};
}
