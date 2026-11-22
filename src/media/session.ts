import narrate from '../../prompts/narrate.md' with { type: 'text' };
import type { LiveClientMessage, LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { buildDelegationContextAppend, buildSessionContextAppend, chunkLiveContext } from './live-sdk.generated.mjs';
import type { VoiceTrace } from './trace';

export interface VoiceCallbacks {
	onTranscript(role: 'user' | 'assistant', text: string, utteranceId?: string): void;
	onSpeechStarted(utteranceId: string): void;
	onInterrupt(): void;
	onAudio(pcm: Uint8Array): void | Promise<void>;
}
interface Output {
	frames: Uint8Array[];
	cursor: number;
	playStart?: number;
	voiced: boolean;
	quietFrames: number;
}
interface Onset { id: string; providerSeen: boolean }
const FRAME_MS = 20, QUIET_FRAMES = 30, PLAYOUT_LEAD_MS = 100;
// Bound transport backpressure, not the length of a spoken response.
const QUEUED_FRAMES = 250, FIRST_VOICE_MS = 10_000;
export class NoVoiceAudioError extends Error {
	constructor() { super('No voice audio received from the voice service') }
}
function energy(pcm: Uint8Array) {
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let sum = 0;
	for (let i = 0; i < 960; i += 2) { const sample = view.getInt16(i, true); sum += sample * sample }
	return sum / 480;
}
function bounded(s: string, max = 8192) { return typeof s === 'string' && s.length <= max && s.trim().length > 0 && !s.includes('\0') }

/** Audio streams independently of decision handling. Only a bound caller turn
 * can reach the decision owner; assistant speech and delegations cannot submit. */
export class VoiceSession {
	#live = true;
	#output?: Output;
	#awaitingAudio?: NodeJS.Timeout;
	#wake?: NodeJS.Timeout;
	#onset?: Onset;
	#ambiguous = false;
	#inputHot = false;
	#quietInput = 0;
	#revision = 0;
	#writing = false;
	#sending = false;
	#seen = new Set<string>();
	constructor(private readonly cb: VoiceCallbacks, private readonly send: (m: LiveClientMessage) => Promise<void>, private readonly fail: (e: Error) => void, private readonly trace?: VoiceTrace) {}

	#clearAudio() {
		clearTimeout(this.#wake); this.#wake = undefined;
		this.#output = undefined;
	}
	#clearAudioDeadline() {
		clearTimeout(this.#awaitingAudio); this.#awaitingAudio = undefined;
	}
	stop() {
		this.#live = false; ++this.#revision;
		this.#onset = undefined; this.#seen.clear(); this.#clearAudio(); this.#clearAudioDeadline();
	}
	#speech(provider: boolean) {
		this.trace?.step(provider ? 'onset.provider' : 'onset.local');
		this.#clearAudioDeadline();
		if (provider) this.#clearAudio();
		if (this.#ambiguous) return;
		if (this.#onset) {
			// Pauses in a caller's sentence are not separate decisions.
			if (!provider) return;
			if (!this.#onset.providerSeen) { this.#onset.providerSeen = true; return }
			this.#ambiguous = true; this.#onset = undefined; ++this.#revision;
			this.cb.onInterrupt(); return;
		}
		++this.#revision;
		this.#onset = { id: crypto.randomUUID(), providerSeen: provider };
		// Capture the current draft at onset, never after a delayed final transcript.
		// Raw microphone energy does not mute audio: route startup can be noisy.
		this.cb.onSpeechStarted(this.#onset.id); this.trace?.step('speech.started.callback');
	}
	input(pcm: Uint8Array) {
		if (!this.#live || pcm.length !== 960) throw new Error('Invalid voice input');
		if (energy(pcm) >= 800 ** 2) {
			this.#quietInput = 0;
			if (!this.#inputHot) { this.#inputHot = true; this.#speech(false) }
		} else if (this.#inputHot && ++this.#quietInput >= 20) this.#inputHot = false;
	}
	#pump(output: Output) {
		if (!this.#live || this.#output !== output || this.#writing || !output.voiced) return;
		if (output.cursor === output.frames.length) {
			if (output.quietFrames >= QUIET_FRAMES) {
				this.trace?.step('rtp.end.quiet_frames'); this.#output = undefined;
			}
			return;
		}
		const now = performance.now();
		if (output.playStart === undefined) {
			output.playStart = now; this.trace?.step('rtp.replay.started');
		}
		// Only sample-clock pacing and a small handset lead remain; no transcript gate.
		let due = output.playStart + output.cursor * FRAME_MS - PLAYOUT_LEAD_MS;
		if (now - due > PLAYOUT_LEAD_MS) {
			output.playStart = now - output.cursor * FRAME_MS;
			due = now - PLAYOUT_LEAD_MS;
		}
		if (due > now) {
			if (!this.#wake) this.#wake = setTimeout(() => { this.#wake = undefined; this.#pump(output) }, Math.ceil(due - now));
			return;
		}
		const frame = output.frames[output.cursor++];
		if (output.cursor >= 64) {
			output.playStart += output.cursor * FRAME_MS;
			output.frames.copyWithin(0, output.cursor);
			output.frames.length -= output.cursor; output.cursor = 0;
		}
		let write: void | Promise<void>;
		try { write = this.cb.onAudio(frame) }
		catch { this.stop(); this.fail(new Error('Handset audio delivery failed')); return }
		if (!write) { this.#pump(output); return }
		this.#writing = true;
		void write.then(() => {
			this.#writing = false;
			if (this.#output) this.#pump(this.#output);
		}, () => { if (this.#live) { this.stop(); this.fail(new Error('Handset audio delivery failed')) } });
	}
	rtp(pcm: Uint8Array) {
		if (!this.#live) return;
		if (pcm.length !== 960) throw new Error('Invalid voice output');
		const output = this.#output ??= {frames:[],cursor:0,voiced:false,quietFrames:0};
		const voiced = energy(pcm) >= 64 ** 2;
		if (!output.voiced && !voiced && output.frames.length === 5) output.frames.shift();
		if (output.frames.length - output.cursor >= QUEUED_FRAMES) {
			this.stop(); this.fail(new Error('Handset audio delivery stalled')); return;
		}
		if (voiced) {
			if (!output.voiced) this.trace?.step('rtp.first_voiced');
			output.voiced = true; output.quietFrames = 0; this.#clearAudioDeadline();
		} else if (output.voiced) {
			if (output.quietFrames >= QUIET_FRAMES) return;
			++output.quietFrames;
		}
		output.frames.push(pcm); this.#pump(output);
	}
	async sendSpeakable(text: string, instruction = false) {
		if (!this.#live || !bounded(text) || this.#sending) throw new Error('Cannot append voice context');
		const revision = this.#revision;
		this.#sending = true; this.#clearAudioDeadline();
		this.#awaitingAudio = setTimeout(() => {
			this.#awaitingAudio = undefined;
			if (this.#live) { this.stop(); this.fail(new NoVoiceAudioError()) }
		}, FIRST_VOICE_MS);
		this.#awaitingAudio.unref();
		try {
			const message = instruction ? text : narrate + JSON.stringify(text);
			for (const chunk of chunkLiveContext(message)) {
				if (!this.#live || revision !== this.#revision) return;
				await this.send(buildSessionContextAppend(chunk, 'speakable'));
			}
			this.trace?.step(instruction ? 'readback.sent' : 'speakable.sent');
		} finally { this.#sending = false }
	}
	async event(event: LiveServerEvent) {
		if (!this.#live) return;
		try {
			this.trace?.sideband(event);
			switch (event.type) {
				case 'unknown':
					if (event.wireType === 'input_audio_buffer.speech_started') this.#speech(true);
					else if (['turn.interrupted','response.cancelled','output_audio_buffer.cleared'].includes(event.wireType)) {
						this.#clearAudio(); this.#clearAudioDeadline();
						if (!this.#onset) { ++this.#revision; this.cb.onInterrupt() }
					}
					return;
				case 'delegation.created': {
					const id = event.item.id;
					if (!bounded(id, 128) || this.#seen.has(id)) return;
					if (this.#seen.size >= 128) throw new Error('Excessive voice delegations');
					this.#seen.add(id);
					await this.send(buildDelegationContextAppend(id, 'No work was started. The desktop is handling the caller’s own speech.', 'commentary'));
					return;
				}
				case 'error': throw new Error('Codex voice connection failed');
				case 'input_transcript.added':
					if (!this.#onset?.providerSeen && !this.#ambiguous) this.#speech(true);
					return;
				case 'output_audio.delta': {
					if (!event.audio || event.audio.length > 64000 || !/^[A-Za-z0-9+/]+$/.test(event.audio)) throw new Error('Invalid ordered voice audio');
					const pcm = Buffer.from(event.audio, 'base64');
					if (!pcm.length || pcm.length % 960 !== 0) throw new Error('Invalid ordered voice audio');
					for (let offset = 0; offset < pcm.length; offset += 960) this.rtp(pcm.subarray(offset, offset + 960));
					return;
				}
				case 'turn.done': break;
				default: return;
			}
			const { role, transcript } = event.turn;
			if (role === 'assistant') {
				if (bounded(transcript)) this.cb.onTranscript(role, transcript);
				return;
			}
			const onset = this.#ambiguous ? undefined : this.#onset;
			this.#onset = undefined; this.#ambiguous = false;
			if (!bounded(transcript)) { this.cb.onInterrupt(); return }
			this.cb.onTranscript(role, transcript, onset?.id);
			this.trace?.step(onset ? 'final.user.bound' : 'final.user.unbound');
		} catch { if (this.#live) { this.stop(); this.fail(new Error('Voice event failed')) } }
	}
}
