import { readFileSync } from 'node:fs';
import type { LiveClientMessage, LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { buildDelegationContextAppend, buildSessionContextAppend, chunkLiveContext } from './live-sdk.generated.mjs';
import type { VoiceTrace } from './trace';
const narrate = readFileSync(new URL('../../prompts/narrate.md', import.meta.url), 'utf8');

export interface VoiceCallbacks {
	onTranscript(role: 'user' | 'assistant', text: string, utteranceId?: string): void | 'consulting' | 'deciding';
	onSpeechStarted(utteranceId: string): void;
	onInterrupt(): void;
	onAudio(pcm: Uint8Array): void | Promise<void>;
	onSpeech(expected: string, actual: string): boolean | Promise<boolean>;
	onReadback(mark: string, actualAssistantFinal: string): boolean | Promise<boolean>;
	onMark(mark: string): void;
}
interface Reading {
	target: {mark:string} | {text:string; retry:boolean};
	phase: 'sending' | 'awaiting' | 'verifying' | 'verified' | 'discarding' | 'marked' | 'played' | 'confirming';
	candidate?: string;
	expires: number;
	frames: { pcm: Uint8Array; received: number }[];
	cursor: number;
	playStart?: number;
	nextFrameAt: number;
	lastVoicedAt: number;
	audibleFrames: number;
	quietFrames: number;
	lastFrameAt: number;
}
interface Onset { id: string; providerSeen: boolean }
// RTP and sideband have no common watermark. Decoded quiet PCM or a bounded
// receive gap after real voiced output fences only the forwarded PCM prefix.
// Neither endpoint observation means physical handset playout.
const FRAME_MS = 20, QUIET_FRAMES = 30, INACTIVE_MS = 1200;
const FIRST_VOICE_MS = 10_000;
const FIRST_PLAYBACK_MS = 20_000;
export class VoicePlaybackTimeout extends Error {
	constructor() { super('Voice audio arrived but verified playback did not start') }
}
export class NoVoiceAudioError extends Error {
	constructor() { super('No voice audio received from the voice service') }
}
export class UngroundedSpeechError extends Error {
	constructor() { super('Voice response did not match the desktop question or answer') }
}
// At most 45 seconds / 2.16 MB of decoded PCM; total readback lifetime
// includes verification, paced replay, physical receipt and the caller's reply.
const BUFFER_FRAMES = 2250, READBACK_LIFETIME = 120_000;
function energy(pcm: Uint8Array) {
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let sum = 0;
	for (let i = 0; i < 960; i += 2) { const sample = view.getInt16(i, true); sum += sample * sample }
	return sum / 480;
}
function bounded(s: string, max = 8192) { return typeof s === 'string' && s.length <= max && s.trim().length > 0 && !s.includes('\0') }

/** Caller speech reaches exactly one request-scoped decision owner. Provider delegations
 * never get an execution capability, and no transcript can substitute for handset playout. */
export class VoiceSession {
	#live = true;
	#reading?: Reading;
	#expiry?: NodeJS.Timeout;
	#awaitingAudio?: NodeJS.Timeout;
	#wake?: NodeJS.Timeout;
	#wakeAt = Infinity;
	#onset?: Onset;
	#ambiguous = false;
	#inputHot = false;
	#quietInput = 0;
	#cutOutput = false;
	#revision = 0;
	#writing = false;
	#sending = false;
	#seen = new Set<string>();
	constructor(private readonly cb: VoiceCallbacks, private readonly send: (m: LiveClientMessage) => Promise<void>, private readonly fail: (e: Error) => void, private readonly trace?: VoiceTrace) {}

	#clearReadback() {
		clearTimeout(this.#expiry); this.#clearAudioDeadline(); this.#clearWake();
		if (this.#reading) this.#reading.frames.length = 0;
		this.#reading = undefined;
	}
	#clearAudioDeadline() {
		clearTimeout(this.#awaitingAudio); this.#awaitingAudio = undefined;
	}
	stop() {
		this.#live = false; this.#onset = undefined; this.#seen.clear(); this.#clearReadback();
	}
	#interrupt() {
		if (this.#reading) this.#cutOutput = true;
		++this.#revision; this.#clearReadback(); this.trace?.step('interrupt'); this.cb.onInterrupt();
	}
	#overlap(r:Reading) {
		if ('mark' in r.target) { this.#interrupt(); return }
		if (r.phase==='discarding') return;
		// Keep the requested narration, but never play overlapping unchecked audio.
		++this.#revision; this.#clearWake(); this.#clearAudioDeadline();
		r.frames.length=0; r.phase='discarding';
		this.cb.onInterrupt();
		this.#awaitingAudio=setTimeout(()=>{
			if (this.#reading===r) {this.#interrupt();this.fail(new UngroundedSpeechError())}
		}, FIRST_PLAYBACK_MS);
		this.#awaitingAudio.unref();
	}
	async #retrySpeech(r:Reading) {
		this.#interrupt();
		if ('text' in r.target) {
			if (r.target.retry) await this.#speak(r.target.text,undefined,false);
			else this.fail(new UngroundedSpeechError());
		}
	}
	#speech(provider: boolean) {
		this.trace?.step(provider ? 'onset.provider' : 'onset.local');
		const waiting = this.#reading;
		if (!provider && waiting && 'text' in waiting.target && waiting.playStart === undefined) {
			// Mic energy is not recognized speech. A tap or capture startup must
			// not discard an unheard question or cancel its playback deadline.
			waiting.candidate ??= crypto.randomUUID();
			return;
		}
		this.#clearAudioDeadline();
		this.#cutOutput = true;
		if (this.#ambiguous) return;
		if (this.#onset) {
			// Pauses within an ordinary proposal do not split the provider turn.
			if (!provider && this.#reading?.phase !== 'confirming') return;
			if (provider && !this.#onset.providerSeen) { this.#onset.providerSeen = true; return }
			this.#ambiguous = true; this.#onset = undefined; this.#interrupt(); return;
		}
		const r = this.#reading;
		// A delayed provider onset by itself cannot prove that the phone user
		// started speaking after physical playout. Require a fresh handset PCM edge.
		if (!provider && r?.phase === 'played' && performance.now() < r.expires) { r.phase = 'confirming'; ++this.#revision }
		else this.#interrupt();
		this.#onset = { id: crypto.randomUUID(), providerSeen: provider };
		this.cb.onSpeechStarted(this.#onset.id); this.trace?.step('speech.started.callback');
	}
	input(pcm: Uint8Array) {
		if (!this.#live || pcm.length !== 960) throw new Error('Invalid voice input');
		if (energy(pcm) >= 800 ** 2) {
			this.#quietInput = 0;
			if (!this.#inputHot) { this.#inputHot = true; this.#speech(false) }
		} else if (this.#inputHot && ++this.#quietInput >= 20) this.#inputHot = false;
	}
	#clearWake() {
		clearTimeout(this.#wake); this.#wake = undefined; this.#wakeAt = Infinity;
	}
	#wakeAtTime(r: Reading, at: number) {
		if (at >= this.#wakeAt) return;
		this.#clearWake(); this.#wakeAt = at;
		this.#wake = setTimeout(() => { this.#clearWake(); this.#pump(r) }, Math.max(0, Math.ceil(at - performance.now())));
		this.#wake.unref();
	}
	#pump(r: Reading) {
		if (this.#reading !== r || r.phase !== 'verified' || this.#writing || this.#onset || r.audibleFrames < 5) return;
		const now = performance.now();
		if (now >= r.expires) { this.#interrupt(); return }
		// When silence continues indefinitely, fence its first complete tail.
		// Any later voiced frame already captured extends the required prefix.
		const tail = r.quietFrames >= QUIET_FRAMES, gapAt = r.lastVoicedAt + INACTIVE_MS;
		const fence = r.frames.length - (tail ? r.quietFrames - QUIET_FRAMES : 0);
		if (r.cursor >= fence) {
			if (!tail && now < gapAt) { this.#wakeAtTime(r, gapAt); return }
			this.trace?.step(tail ? 'rtp.end.quiet_frames' : now - r.lastFrameAt >= INACTIVE_MS ? 'rtp.end.receive_gap' : 'rtp.end.quiet_gap');
			this.#clearWake(); r.frames.length = 0;
			if ('mark' in r.target) {
				r.phase = 'marked'; this.cb.onMark(r.target.mark); this.trace?.step('mark.emitted');
			} else this.#clearReadback();
			return;
		}
		if (r.playStart === undefined) { r.playStart = now; this.#clearAudioDeadline(); this.trace?.step('rtp.replay.started') }
		const frame = r.frames[r.cursor];
		// Respect real receive gaps as well as the 20 ms sample duration.
		const due = Math.max(r.nextFrameAt, r.playStart + (frame.received - r.frames[0].received));
		if (due > now) { this.#wakeAtTime(r, due); return }
		++r.cursor; r.nextFrameAt = now + FRAME_MS;
		const write = this.cb.onAudio(frame.pcm);
		if (!write) { this.#pump(r); return }
		this.#writing = true;
		void write.then(() => {
			this.#writing = false;
			if (this.#reading && this.#live) this.#pump(this.#reading);
		}, () => { if (this.#live) { this.stop(); this.fail(new Error('Handset audio delivery failed')) } });
	}
	played(mark: string) {
		const r = this.#reading;
		if (!this.#live || !r || r.phase !== 'marked' || performance.now() >= r.expires || this.#onset || this.#inputHot || !('mark' in r.target) || r.target.mark !== mark) return false;
		r.phase = 'played'; this.trace?.step('mark.played'); return true;
	}
	rtp(pcm: Uint8Array) {
		if (!this.#live) return;
		if (pcm.length !== 960) throw new Error('Invalid voice output');
		const r = this.#reading;
		if (this.#cutOutput || !r || r.phase==='discarding') return; // Never stream speculative audio.
		const voiced = energy(pcm) >= 64 ** 2;
		if (r.phase === 'marked' || r.phase === 'played' || r.phase === 'confirming') {
			if (voiced) this.#interrupt(); return;
		}
		if (r.frames.length >= BUFFER_FRAMES || performance.now() >= r.expires) {
			this.trace?.step('rtp.replay.limit'); this.#interrupt();
			if ('text' in r.target) this.fail(new UngroundedSpeechError());
			return;
		}
		// The peer transfers a distinct immutable buffer per decoded frame.
		// Capture from the append itself: a gap is not a reliable start marker.
		const received = performance.now(); r.lastFrameAt = received;
		r.frames.push({pcm, received});
		if (voiced) {
			if (++r.audibleFrames === 1) {
				this.trace?.step('rtp.first_voiced');
				if (this.#awaitingAudio) {
					this.trace?.step('speakable.first_voiced'); this.#clearAudioDeadline();
					this.#awaitingAudio = setTimeout(() => {
						if (this.#reading !== r) return;
						this.#interrupt(); this.fail(new VoicePlaybackTimeout());
					}, FIRST_PLAYBACK_MS);
					this.#awaitingAudio.unref();
				}
			}
			r.lastVoicedAt = received; r.quietFrames = 0;
		} else if (r.audibleFrames) ++r.quietFrames;
		this.#pump(r);
	}
	sendSpeakable(text: string, mark?: string) {
		return this.#speak(text, mark, true);
	}
	async #speak(text: string, mark: string | undefined, retry: boolean) {
		if (!this.#live || !bounded(text) || this.#sending) throw new Error('Cannot append voice context');
		this.#clearAudioDeadline();
		if (this.#reading) this.#interrupt();
		const revision = this.#revision;
		if (mark !== undefined && (!bounded(mark, 128) || this.#onset || this.#ambiguous)) throw new Error('Cannot bind voice readback');
		const now = performance.now();
		const r:Reading = this.#reading = { target:mark === undefined ? {text,retry} : {mark}, phase:'sending', expires:now + READBACK_LIFETIME,
			frames:[], cursor:0, nextFrameAt:0, lastVoicedAt:-Infinity, audibleFrames:0, quietFrames:0, lastFrameAt:-Infinity };
		this.#expiry = setTimeout(() => {
			if (r !== this.#reading) return;
			this.#interrupt();
			if ('text' in r.target) this.fail(new UngroundedSpeechError());
		}, READBACK_LIFETIME); this.#expiry.unref();
		this.#cutOutput = false; this.#sending = true;
		// A successful context append is not audio. Retry only unmarked speech;
		// never replay or authorize a decision readback from this timer.
		if (mark === undefined) {
			this.#awaitingAudio = setTimeout(() => {
				this.#awaitingAudio = undefined;
				if (!retry || this.#sending) { this.trace?.step('speakable.no_audio'); this.fail(new NoVoiceAudioError()); return }
				this.trace?.step('speakable.retry');
				void this.#speak(text, undefined, false).catch(() => { if (this.#live) this.fail(new NoVoiceAudioError()) });
			}, FIRST_VOICE_MS);
			this.#awaitingAudio.unref();
		}
		try {
			const message = mark === undefined ? narrate + JSON.stringify(text) : text;
			for (const chunk of chunkLiveContext(message)) {
				if (!this.#live || revision !== this.#revision) return;
				await this.send(buildSessionContextAppend(chunk, 'speakable'));
			}
			if (!this.#live || revision !== this.#revision) return;
			r.phase = 'awaiting'; this.trace?.step(mark === undefined ? 'speakable.sent' : 'readback.sent');
		} catch (error) { if (r && this.#reading === r) this.#interrupt(); throw error }
		finally { this.#sending = false }
	}
	async event(event: LiveServerEvent) {
		if (!this.#live) return;
		try {
			this.trace?.sideband(event);
			const r = this.#reading;
			const mutedReply = this.#cutOutput && r?.phase === 'confirming';
			switch (event.type) {
				case 'unknown':
					if (event.wireType === 'input_audio_buffer.speech_started') this.#speech(true);
					else if (!mutedReply && ['turn.interrupted','response.cancelled','output_audio_buffer.cleared'].includes(event.wireType)) this.#interrupt();
					else if (!mutedReply && event.wireType === 'output_audio_buffer.started' && r && r.phase !== 'sending' && r.phase !== 'awaiting') this.#overlap(r);
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
				case 'input_transcript.added': if (!this.#onset && r && !r.candidate) this.#interrupt(); return;
				case 'output_audio.delta': case 'output_transcript.added':
					if (!mutedReply && r && r.phase !== 'sending' && r.phase !== 'awaiting') this.#overlap(r); return;
				case 'turn.done': break;
				default: return;
			}
			const { role, transcript } = event.turn;
			if (role === 'assistant' && mutedReply) return;
			if (!bounded(transcript)) { this.#onset = undefined; this.#ambiguous = false; this.#interrupt(); return }
			if (role === 'assistant') {
				this.cb.onTranscript(role, transcript);
				if (!r) return;
				if (r.phase==='discarding') {await this.#retrySpeech(r);return}
				if (r.phase !== 'awaiting' || this.#onset || this.#ambiguous) { this.#interrupt(); return }
				r.phase = 'verifying';
				let valid = false;
				try {
					if ('mark' in r.target) valid = await this.cb.onReadback(r.target.mark, transcript);
					else valid = await this.cb.onSpeech(r.target.text, transcript);
				} catch { /* No decision-owner approval. */ }
				if (!this.#live || this.#reading !== r || r.phase !== 'verifying') return;
				if (!valid) {
					this.trace?.step('readback.rejected');
					await this.#retrySpeech(r);
					return;
				}
				r.phase = 'verified'; this.trace?.step('readback.verified');
				if (this.trace) {
					this.trace.step(!r.audibleFrames ? 'rtp.voice.none' : r.audibleFrames < 5 ? 'rtp.voice.partial' : 'rtp.voice.enough');
					this.trace.step(!r.quietFrames ? 'rtp.quiet.none' : r.quietFrames < QUIET_FRAMES ? 'rtp.quiet.partial' : 'rtp.quiet.enough');
					this.trace.step(this.#writing ? 'rtp.writes.pending' : 'rtp.writes.drained');
					this.trace.step(performance.now() - r.lastFrameAt >= INACTIVE_MS ? 'rtp.receive.idle' : 'rtp.receive.recent');
				}
				this.#pump(r); return;
			}
			const deferred = !this.#onset && r?.candidate;
			const onset = this.#onset ?? (deferred ? {id:deferred,providerSeen:false} : undefined);
			this.#onset = undefined; this.#ambiguous = false;
			if (r?.phase === 'confirming' && onset && performance.now() < r.expires) this.#clearReadback();
			else if (r) this.#interrupt();
			if (deferred) { this.cb.onSpeechStarted(deferred); this.trace?.step('speech.started.callback') }
			const claim = this.cb.onTranscript(role, transcript, onset?.id);
			this.#cutOutput = !!onset && (claim === 'deciding' || claim === 'consulting');
			if (this.#cutOutput) { ++this.#revision; this.trace?.step(claim === 'consulting' ? 'consult.claimed' : 'decision.claimed') }
			this.trace?.step(onset ? 'final.user.bound' : 'final.user.unbound');
		} catch { if (this.#live) this.fail(new Error('Voice event failed')) }
	}
}
