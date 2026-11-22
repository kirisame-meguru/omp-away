import { buildDelegationContextAppend, buildSessionContextAppend, chunkLiveContext, type LiveClientMessage, type LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';

export interface VoiceCallbacks {
	consult(question: string, signal: AbortSignal): Promise<string>;
	onTranscript(role: 'user' | 'assistant', text: string, utteranceId?: string): void;
	onSpeechStarted(utteranceId: string): void;
	onInterrupt(): void;
	onAudio(pcm: Uint8Array): void | Promise<void>;
	onProvisional(mark: string, utteranceId: string, finalTranscript: string): boolean;
	onMark(mark: string): void;
}
type Readback = { text: string; phrase: string; mark: string; expires: number; sent: boolean; audio: boolean; verified: boolean };
type Onset = { id: string; source: 'local' | 'provider' | 'both'; receipt?: Readback };
const LIMIT = 8192;
const clean = (s: string) => s.normalize('NFC').trim().replace(/\s+/gu, ' ');
const answer = (s: string) => clean(s).toLowerCase().replace(/^yes,?\s+submit,?\s+/, 'yes submit ').replace(/[.!]$/, '');
function signalEnergy(pcm: Uint8Array) {
	// 20 ms PCM windows. Only used to detect interruption/onset, never to prove a drain.
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let sum = 0;
	for (let i = 0; i < 960; i += 2) { const s = view.getInt16(i, true); sum += s * s }
	return sum / 480;
}
function bounded(s: string, max = LIMIT) { return typeof s === 'string' && s.length <= max && s.trim().length > 0 && !s.includes('\0') }

/** No session/extension/host object here: even a malicious delegation has only the
 * scoped, tool-free consultation capability. Data-plane messages cannot reach this API. */
export class VoiceSession {
	#live = true;
	#readback?: Readback;
	#expiry?: ReturnType<typeof setTimeout>;
	#onset?: Onset;
	#ambiguous = false;
	#inputHot = false;
	#cutOutput = false;
	#output?: Promise<void>;
	#queued = 0;
	#revision = 0;
	#quiet = 0;
	#consultation?: AbortController;
	#seen = new Set<string>();
	#sending = false;
	constructor(private readonly cb: VoiceCallbacks, private readonly send: (m: LiveClientMessage) => Promise<void>, private readonly fail: (e: Error) => void) {}

	stop() {
		this.#live = false; this.#readback = undefined; this.#onset = undefined;
		clearTimeout(this.#expiry); this.#expiry = undefined;
		this.#cancelConsult(); this.#seen.clear();
	}
	#cancelConsult() { this.#consultation?.abort(); this.#consultation = undefined }
	#interrupt() {
		++this.#revision; this.#readback = undefined;
		clearTimeout(this.#expiry); this.#expiry = undefined;
		this.#cancelConsult(); this.cb.onInterrupt();
	}
	#speech(source: 'local' | 'provider') {
		this.#cutOutput = true;
		if (this.#ambiguous) return;
		if (this.#onset) {
			if (this.#onset.source !== source && this.#onset.source !== 'both') { this.#onset.source = 'both'; return }
			this.#onset = undefined; this.#ambiguous = true; this.#interrupt(); return;
		}
		const id = crypto.randomUUID(), r = this.#readback;
		if (r?.verified && performance.now() < r.expires) {
			this.#onset = { id, source, receipt: r };
		} else {
			this.#interrupt(); this.#onset = { id, source }; this.cb.onSpeechStarted(id);
		}
	}
	input(pcm: Uint8Array) {
		if (!this.#live || pcm.length !== 960) throw new Error('Invalid voice input');
		if (signalEnergy(pcm) >= 800 ** 2) {
			this.#quiet = 0;
			if (!this.#inputHot) { this.#inputHot = true; this.#speech('local') }
		} else if (this.#inputHot && ++this.#quiet >= 20) this.#inputHot = false;
	}
	rtp(pcm: Uint8Array) {
		if (!this.#live) return;
		if (pcm.length !== 960) throw new Error('Invalid voice output');
		if (this.#cutOutput) return; // Drop, never replay buffered speech after an interruption.
		if (this.#queued >= 12) {
			this.stop(); this.fail(new Error('Handset audio stalled')); return;
		}
		const revision = this.#revision, r = this.#readback;
		const deliver = () => {
			if (!this.#live || revision !== this.#revision) return;
			if (r && signalEnergy(pcm) >= 64 ** 2) r.audio = true;
			return this.cb.onAudio(pcm);
		};
		const operation = this.#output ? this.#output.then(deliver) : deliver();
		if (operation) {
			++this.#queued;
			const tail = this.#output = operation.catch(() => {
				if (this.#live) { this.stop(); this.fail(new Error('Handset audio delivery failed')) }
			});
			void tail.then(() => { --this.#queued; if (this.#output === tail) this.#output = undefined });
		}
	}
	async sendSpeakable(text: string, mark?: string, confirmationPhrase?: string) {
		if (!this.#live || !bounded(text) || this.#sending) throw new Error('Cannot append voice context');
		if (this.#expiry) this.#interrupt();
		let r: Readback | undefined;
		if (mark !== undefined || confirmationPhrase !== undefined) {
			if (!mark || !bounded(mark, 128) || !confirmationPhrase || !bounded(confirmationPhrase, 256) || this.#onset || this.#ambiguous)
				throw new Error('Cannot bind voice readback');
			const phrase = answer(confirmationPhrase);
			const words = /^yes submit ((?:[a-z]+ ){3,7}[a-z]+)$/.exec(phrase)?.[1];
			if (!words || new Set(words.split(' ')).size !== words.split(' ').length || !clean(text).endsWith(`Your words are ${words}.`) ||
				clean(text).toLowerCase().replace(/[,;:.!?]/g, '').includes(phrase)) throw new Error('Readback requires a distinct fresh acoustic tail');
			r = { text: clean(text), phrase, mark, expires: performance.now() + 120_000, sent: false, audio: false, verified: false };
			this.#readback = r;
			// Expiry may only REVOKE. Even after issuing a mark, a delayed handset ACK
			// cannot complete this request after the proof window.
			this.#expiry = setTimeout(() => {
				try { this.#interrupt() } catch { this.fail(new Error('Could not revoke expired readback')) }
			}, 120_000);
			this.#expiry.unref();
		}
		this.#cutOutput = false;
		this.#cancelConsult();
		this.#sending = true;
		try {
			for (const chunk of chunkLiveContext(text)) {
				if (!this.#live || (r && this.#readback !== r)) throw new Error('Voice context interrupted');
				await this.send(buildSessionContextAppend(chunk, 'speakable'));
			}
			if (r) r.sent = true;
		} catch (error) { if (r && this.#readback === r) this.#interrupt(); throw error }
		finally { this.#sending = false }
	}
	async #delegate(item: Extract<LiveServerEvent, { type: 'delegation.created' }>['item']) {
		this.#interrupt();
		if (!bounded(item.id, 128) || this.#seen.has(item.id)) return;
		if (this.#seen.size >= 128) throw new Error('Too many voice delegations');
		this.#seen.add(item.id);
		let question: string | undefined;
		if (item.content.length === 1 && bounded(item.content[0].text, 1200)) {
			try {
				const data = JSON.parse(item.content[0].text);
				if (data && Object.keys(data).length === 2 && data.kind === 'clarify' && bounded(data.question, 1000)) {
					const q = data.question.trim();
					// Keep the delegation a single informational question, not an imperative.
					// This grammar is not the security boundary: consult has no execution capability.
					if (/^(?:(?:what|why|how|which|when|where|is|are|does|do)\b|(?:can|could|would) you (?:explain|clarify|describe|compare)\b)[^?;\r\n]*\?$/iu.test(q)) question = q;
				}
			} catch { /* Free-form work directives are not a consultation request. */ }
		}
		const controller = new AbortController(); this.#consultation = controller;
		try {
			let text = 'This call only clarifies the pending decision. It cannot start work.';
			if (question) text = await this.cb.consult(question, controller.signal);
			if (!this.#live || controller.signal.aborted) return;
			if (!bounded(text)) throw new Error('Invalid consultation result');
			this.#cutOutput = false;
			for (const chunk of chunkLiveContext(text)) {
				if (!this.#live || controller.signal.aborted) return;
				await this.send(buildDelegationContextAppend(item.id, chunk, 'speakable'));
			}
		} catch (error) { if (!controller.signal.aborted) throw error }
		finally { if (this.#consultation === controller) this.#consultation = undefined }
	}
	async event(event: LiveServerEvent) {
		if (!this.#live) return;
		try {
			const r = this.#readback;
			if (!r && this.#expiry && (event.type === 'turn.done' || event.type === 'input_transcript.added' || event.type === 'output_transcript.added' || event.type === 'output_audio.delta')) this.#interrupt();
			switch (event.type) {
				case 'unknown':
					if (event.wireType === 'input_audio_buffer.speech_started') this.#speech('provider');
					else if (['turn.interrupted', 'response.cancelled', 'output_audio_buffer.cleared'].includes(event.wireType)) this.#interrupt();
					return;
				case 'delegation.created': await this.#delegate(event.item); return;
				case 'error': throw new Error('Codex voice connection failed');
				case 'input_transcript.added':
					if (!this.#onset && r) this.#interrupt(); // text alone cannot manufacture a speech start
					return;
				case 'output_transcript.added': if (r?.verified) this.#interrupt(); return;
				case 'output_audio.delta': return; // no codec, RTP end timestamp, or turn id in SDK 19.1
				case 'turn.done': break;
				default: return;
			}
			const { role, transcript } = event.turn;
			if (!bounded(transcript)) { this.#onset = undefined; this.#ambiguous = false; this.#interrupt(); return }
			if (role === 'assistant') {
				if (r) {
					if (!r.verified && r.sent && clean(transcript) === r.text && !this.#onset && !this.#ambiguous && performance.now() < r.expires) r.verified = true;
					else this.#interrupt();
				}
				this.cb.onTranscript(role, transcript); return;
			}
			const onset = this.#onset; this.#onset = undefined; this.#ambiguous = false;
			if (onset?.receipt || r) {
				this.#readback = undefined;
				if (r && r === onset?.receipt && r.verified && r.audio && performance.now() < r.expires && answer(transcript) === r.phrase && this.cb.onProvisional(r.mark, onset.id, transcript) === true) {
					const revision = this.#revision;
					if (this.#output) await this.#output;
					if (this.#live && revision === this.#revision && performance.now() < r.expires) this.cb.onMark(r.mark);
					return;
				}
				this.#interrupt();
				// We withheld the real onset pending classification. Deliver it only after
				// invalidation, so a negative/change can still discard or revise the proposal.
				if (onset?.receipt) this.cb.onSpeechStarted(onset.id);
			}
			this.#cutOutput = false;
			this.cb.onTranscript(role, transcript, onset?.id);
		} catch { if (this.#live) this.fail(new Error('Voice event failed')) }
	}
}
