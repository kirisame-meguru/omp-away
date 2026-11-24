import narrate from '../../prompts/narrate.md' with { type: 'text' };
import type { LiveClientMessage, LiveServerEvent } from './protocol';
import { buildDelegationContextAppend, buildSessionContextAppend, chunkLiveContext } from './live-sdk.generated.mjs';
import type { VoiceTrace } from './trace';
import type { CallLog } from './call-log';

export interface VoiceCallbacks {
	onTranscript(role: 'user' | 'assistant', text: string, utteranceId?: string): void;
	onSpeechStarted(utteranceId: string, startedAt?: number): void;
	onInterrupt(): void;
	onAudio(pcm: Uint8Array): void | Promise<void>;
	onCaption?(role: 'user' | 'assistant', text: string, final: boolean): void;
}
interface Output {
	frames: Uint8Array[];
	cursor: number;
	playStart?: number;
	voiced: boolean;
	quietFrames: number;
}
interface Onset { id: string; providerSeen: boolean; startedAt: number; reboundThrough?:number }
interface Readback {
	at:number; until:number; sealed:boolean; receivedThrough?:number; spokenThrough?:number;
}
interface PendingInput {text:string; startMs:number; endMs:number; segmentStartMs:number; changedAt:number}
const FRAME_MS = 20, QUIET_FRAMES = 30, PLAYOUT_LEAD_MS = 100;
// Bound transport backpressure, not the length of a spoken response.
const QUEUED_FRAMES = 250, FIRST_VOICE_MS = 10_000;
// Endpoint only stable recognition plus live caller silence, never output quiet or a stalled microphone.
const ENDPOINT_MS = 1500, ENDPOINT_FRAMES = ENDPOINT_MS / FRAME_MS, INPUT_FRESH_MS = 250;
const ONSET_FRAMES = 3; // Reject isolated 20 ms microphone/echo spikes.
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
	#latestLocalAt?: number;
	#readback?: Readback;
	#sentContexts = 0;
	#ackedContexts = 0;
	#contextThrough = -1;
	#contextAligned = true;
	#ambiguous = false;
	#inputHot = false;
	#hotInputFrames = 0;
	#hotInputAt = 0;
	#quietInput = 0;
	#lastInputAt = -Infinity;
	#lastVoicedAt = -Infinity;
	#pendingInput?: PendingInput;
	#finalizedInput?: PendingInput & {segmentText:string};
	#endpointTimer?: NodeJS.Timeout;
	#endpointBlocked = false;
	#resolvedThrough = -1;
	#revision = 0;
	#writing = false;
	#sending = false;
	#seen = new Set<string>();
	#captionText = {user:'',assistant:''};
	#captionPending = new Set<'user' | 'assistant'>();
	#captionTimer?: NodeJS.Timeout;
	constructor(private readonly cb: VoiceCallbacks, private readonly send: (m: LiveClientMessage) => Promise<void>, private readonly fail: (e: Error) => void, private readonly trace?: VoiceTrace, private readonly log?: CallLog) {}
	#deliverCaption(role: 'user' | 'assistant', text: string, final: boolean) {
		try { this.cb.onCaption?.(role,text,final) }
		catch { this.trace?.step('caption.delivery_failed') }
	}

	#caption(role: 'user' | 'assistant', text: string, final: boolean) {
		if (!this.cb.onCaption) return;
		if (final) {
			this.#captionPending.delete(role); this.#captionText[role] = '';
			if (!this.#captionPending.size) { clearTimeout(this.#captionTimer); this.#captionTimer = undefined }
			if (bounded(text)) this.#deliverCaption(role,text,true);
			return;
		}
		if (!text || text.includes('\0') || this.#captionText[role].length + text.length > 8192) return;
		this.#captionText[role] += text; this.#captionPending.add(role);
		this.#captionTimer ??= setTimeout(() => {
			this.#captionTimer = undefined;
			if (!this.#live) return;
			for (const role of this.#captionPending) this.#deliverCaption(role,this.#captionText[role],false);
			this.#captionPending.clear();
		},100);
	}
	#clearEndpoint() {
		clearTimeout(this.#endpointTimer); this.#endpointTimer = undefined; this.#pendingInput = undefined;
		this.#finalizedInput=undefined;
	}
	#armEndpoint() {
		const pending=this.#pendingInput;
		if (!pending || this.#endpointTimer || !this.#live) return;
		this.#endpointTimer=setTimeout(()=>{
			this.#endpointTimer=undefined;
			if (!this.#live || this.#ambiguous || this.#pendingInput!==pending ||
				this.#quietInput<ENDPOINT_FRAMES || performance.now()-this.#lastInputAt>INPUT_FRESH_MS) return;
			if (performance.now()-Math.max(pending.changedAt,this.#lastVoicedAt)<ENDPOINT_MS) {this.#armEndpoint();return}
			try {
				this.#resolvedThrough=Math.max(this.#resolvedThrough,pending.endMs);
				this.trace?.step('endpoint.user');
				this.#finishCaller(pending.text);
			} catch { this.stop(); this.fail(new Error('Voice endpoint failed')) }
		},Math.max(0,Math.ceil(ENDPOINT_MS-(performance.now()-Math.max(pending.changedAt,this.#lastVoicedAt)))));
		this.#endpointTimer.unref();
	}
	#recognition(text:string,startMs:number|undefined,endMs:number|undefined) {
		if (this.#endpointBlocked || this.#ambiguous) return;
		const previous=this.#pendingInput, finalized=this.#finalizedInput;
		const separator=previous && previous===finalized ? ' ' : '';
		if (startMs===undefined || endMs===undefined || startMs<this.#resolvedThrough ||
			startMs<(this.#onset?.reboundThrough??0) ||
			(finalized && (finalized.endMs<0 || startMs<finalized.endMs || endMs<=finalized.endMs)) ||
			!text || text.includes('\0') || text.length+(previous?.text.length??0)+separator.length>8192 ||
			(previous && endMs<previous.endMs)) {
			// Never authorize a retained affirmative prefix when its continuation is unusable.
			this.#endpointBlocked=true; this.#clearEndpoint(); return;
		}
		clearTimeout(this.#endpointTimer); this.#endpointTimer=undefined;
		this.#pendingInput={text:(previous?.text??'')+separator+text,startMs:previous?.startMs??startMs,endMs,
			segmentStartMs:previous && previous!==finalized ? previous.segmentStartMs : startMs,changedAt:performance.now()};
		this.#armEndpoint();
	}
	#completion(text:string,startMs:number|undefined,endMs:number|undefined) {
		const pending=this.#pendingInput, finalized=this.#finalizedInput;
		if (startMs!==undefined && endMs!==undefined &&
			(startMs<this.#resolvedThrough || endMs<=this.#resolvedThrough)) return;
		if (this.#endpointBlocked || this.#ambiguous || !bounded(text)) throw new Error('Unusable caller completion');
		const segmentText=text.trim();
		// Later recognition must not contradict the timestamp that justified repairing stale noise.
		const reboundThrough=this.#onset?.reboundThrough;
		if(reboundThrough!==undefined && (startMs===undefined || startMs<reboundThrough))
			throw new Error('Caller completion precedes repaired onset');
		let aggregate=segmentText, first=startMs??-1;
		if (startMs===undefined || endMs===undefined) {
			if (this.#resolvedThrough>=0 || pending) throw new Error('Unscoped caller continuation');
		} else {
			if (finalized && startMs===finalized.segmentStartMs && endMs===finalized.endMs && segmentText===finalized.segmentText) return;
			if ((pending && endMs<pending.endMs) || (finalized && startMs<finalized.startMs))
				throw new Error('Regressing caller completion');
			if (finalized) {
				if (finalized.endMs<0) throw new Error('Unscoped caller prefix');
				if (startMs>=finalized.endMs) {
					aggregate=finalized.text+' '+segmentText;first=finalized.startMs;
				} else if (startMs>finalized.startMs) throw new Error('Overlapping caller segments');
			}
			if (pending && pending!==finalized && startMs>pending.segmentStartMs)
				throw new Error('Incomplete caller final');
		}
		if (!bounded(aggregate)) throw new Error('Oversize caller completion');
		if (this.#onset && !this.#onset.providerSeen) this.#confirmSpeech(this.#onset,startMs);
		clearTimeout(this.#endpointTimer);this.#endpointTimer=undefined;
		this.#finalizedInput={text:aggregate,startMs:first,endMs:endMs??-1,
			segmentStartMs:startMs??-1,segmentText,changedAt:performance.now()};
		this.#pendingInput=this.#finalizedInput;
		this.#armEndpoint();
	}
	#finishCaller(text:string) {
		const onset=this.#ambiguous ? undefined : this.#onset;
		this.#onset=undefined; this.#ambiguous=false; this.#endpointBlocked=false; this.#clearEndpoint();
		if (onset && !onset.providerSeen) this.#confirmSpeech(onset);
		this.#latestLocalAt=undefined;
		this.#caption('user',text,true);
		if (!bounded(text)) {this.cb.onInterrupt();return}
		this.log?.speech('user','resolved-silence',text,{bound:!!onset});
		this.cb.onTranscript('user',text,onset?.id);
		this.trace?.step(onset ? 'final.user.bound' : 'final.user.unbound');
	}

	#clearAudio() {
		clearTimeout(this.#wake); this.#wake = undefined;
		this.#output = undefined;
	}
	#clearAudioDeadline() {
		clearTimeout(this.#awaitingAudio); this.#awaitingAudio = undefined;
	}
	stop() {
		this.#live = false; ++this.#revision;
		this.#clearEndpoint();
		clearTimeout(this.#captionTimer); this.#captionTimer = undefined;
		this.#captionPending.clear(); this.#captionText.user = this.#captionText.assistant = '';
		this.#onset = undefined; this.#latestLocalAt=undefined; this.#readback=undefined;
		this.#seen.clear(); this.#clearAudio(); this.#clearAudioDeadline();
	}
	#confirmSpeech(onset: Onset, startMs?:number) {
		const readback=this.#readback;
		// A fragment timestamp is not a physical onset. It can only disambiguate
		// stale noise when a fresh local burst AND the completed current readback
		// independently precede this recognized caller turn.
		if (this.#contextAligned && readback?.spokenThrough!==undefined && startMs!==undefined &&
			startMs>=readback.spokenThrough && this.#latestLocalAt!==undefined &&
			this.#latestLocalAt>readback.at && onset.startedAt<readback.at) {
			onset.startedAt=this.#latestLocalAt;
			onset.reboundThrough=readback.spokenThrough;
			this.trace?.step('onset.rebound');
		}
		onset.providerSeen = true; ++this.#revision;
		this.cb.onSpeechStarted(onset.id,onset.startedAt); this.trace?.step('speech.started.callback');
	}
	#speech(provider: boolean, startedAt = this.#hotInputFrames ? this.#hotInputAt : performance.now(), startMs?:number) {
		this.trace?.step(provider ? 'onset.provider' : 'onset.local');
		if (!provider) this.#latestLocalAt=startedAt;
		if (provider) { this.#clearAudioDeadline(); this.#clearAudio() }
		if (this.#ambiguous) return;
		if (this.#onset) {
			// Pauses in a caller's sentence are not separate decisions.
			if (!provider) return;
			if (!this.#onset.providerSeen) { this.#confirmSpeech(this.#onset,startMs); return }
			if (this.#pendingInput && this.#quietInput<ENDPOINT_FRAMES &&
				performance.now()-this.#lastInputAt<=INPUT_FRESH_MS) return;
			this.#ambiguous = true; this.#onset = undefined; ++this.#revision; this.#clearEndpoint();
			this.cb.onInterrupt(); return;
		}
		this.#onset = { id: crypto.randomUUID(), providerSeen: false, startedAt };
		// Energy alone may be route noise or echo, not a new caller turn.
		// Retain its time so delayed recognition cannot approve a newer draft.
		if (provider) this.#confirmSpeech(this.#onset,startMs);
	}
	input(pcm: Uint8Array) {
		if (!this.#live || pcm.length !== 960) throw new Error('Invalid voice input');
		this.#lastInputAt=performance.now();
		if (energy(pcm) >= 800 ** 2) {
			this.#lastVoicedAt=this.#lastInputAt; this.#quietInput=0;
			if (!this.#inputHot) {
				if (this.#hotInputFrames++===0) this.#hotInputAt=this.#lastInputAt;
				if (this.#hotInputFrames>=ONSET_FRAMES) {
					this.#inputHot=true;this.#speech(false,this.#hotInputAt);this.#hotInputFrames=0;
				}
			}
		} else {
			if (++this.#quietInput>=ENDPOINT_FRAMES) this.#armEndpoint();
			this.#hotInputFrames=0;
			if (this.#quietInput>=20) this.#inputHot=false;
		}
		// Android owns acoustic echo cancellation. Output PCM amplitude is not
		// comparable to handset microphone gain; gating it loses interruptions.
		return pcm;
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
			output.frames.length -= output.cursor;
			output.cursor = 0;
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
		const outputEnergy = energy(pcm), voiced = outputEnergy >= 64 ** 2;
		if (!output.voiced && !voiced && output.frames.length === 5) {
			output.frames.shift();
		}
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
	#append(message:LiveClientMessage, readback?:Readback) {
		if (message.type==='session.context.append') {
			++this.#sentContexts;
			if (readback) {readback.until=this.#sentContexts;readback.receivedThrough=undefined}
		}
		return this.send(message);
	}
	appendContext(text:string) {
		if (!this.#live || !bounded(text)) return Promise.reject(new Error('Cannot append voice context'));
		return this.#append(buildSessionContextAppend(text,'commentary'));
	}
	#contextAppended(startMs:number|undefined,endMs:number|undefined) {
		if (!this.#contextAligned) return;
		if (startMs===undefined || endMs===undefined || endMs<=this.#contextThrough ||
			++this.#ackedContexts>this.#sentContexts) {
			// Missing, repeated, or unsolicited acknowledgements cannot repair an
			// onset. Keep the original conservative capture-time guard instead.
			this.#contextAligned=false;this.#readback=undefined;this.trace?.step('context.unaligned');return;
		}
		this.#contextThrough=endMs;
		if(this.#readback?.until===this.#ackedContexts) this.#readback.receivedThrough=endMs;
	}
	async sendSpeakable(text: string, instruction = false) {
		if (!this.#live || !bounded(text) || this.#sending) throw new Error('Cannot append voice context');
		const revision = this.#revision;
		const readback:Readback|undefined=instruction ? this.#readback={at:performance.now(),until:0,sealed:false} : undefined;
		this.#sending = true; this.#clearAudioDeadline();
		this.#awaitingAudio = setTimeout(() => {
			this.#awaitingAudio = undefined;
			if (this.#live) { this.stop(); this.fail(new NoVoiceAudioError()) }
		}, FIRST_VOICE_MS);
		this.#awaitingAudio.unref();
		try {
			const message = instruction
				? 'PREPARE_VALIDATED_READBACK: silent preparation, not a request to speak. Wait for VALIDATED_READBACK_READY.\n'+text
				: narrate + JSON.stringify(text);
			for (const chunk of chunkLiveContext(message)) {
				if (!this.#live || revision !== this.#revision) return;
				await this.#append(buildSessionContextAppend(chunk, instruction?'commentary':'speakable'),readback);
			}
			if(readback) {
				if (!this.#live || revision !== this.#revision) return;
				// One bounded trigger, after the entire draft. Individual data
				// chunks must not independently request repeated readbacks.
				await this.#append(buildSessionContextAppend(
					'VALIDATED_READBACK_READY: Read the complete prepared draft once, following its readback instructions. End with one "Submit?" Do not speak the control markers.',
					'speakable'),readback);
				readback.sealed=true;
			}
			this.trace?.step(instruction ? 'readback.sent' : 'speakable.sent');
			this.log?.event(instruction?'readback-appended':'narration-appended');
		} finally { this.#sending = false }
	}
	async event(event: LiveServerEvent) {
		if (!this.#live) return;
		try {
			this.trace?.sideband(event);
			if(event.type==='input_transcript.added' || event.type==='output_transcript.added')
				this.log?.speech(event.type==='input_transcript.added'?'user':'assistant','delta',event.item.text,event);
			else if(event.type==='turn.done') this.log?.speech(event.turn.role,'provider-final',event.turn.transcript,event);
			switch (event.type) {
				case 'unknown':
					if (event.wireType==='session.context.appended') {this.#contextAppended(event.startMs,event.endMs);return}
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
					// Complete the rejected delegation: commentary would leave it awaiting a desktop answer.
					await this.send(buildDelegationContextAppend(id, 'No delegated work was started. No separate desktop answer to an ordinary question will follow. Answer ordinary questions directly from the supplied task context, stating unknowns. Stay silent for selections, corrections and confirmations; only VALIDATED_READBACK_READY authorizes a readback. Do not speak or acknowledge this control message.'));
					return;
				}
				case 'error': throw new Error('Codex voice connection failed');
				case 'input_transcript.added':
					if (event.endMs!==undefined && event.endMs<=this.#resolvedThrough) return;
					this.#caption('user',event.item.text,false);
					if (!this.#onset?.providerSeen && !this.#ambiguous) this.#speech(true,undefined,event.startMs);
					this.#recognition(event.item.text,event.startMs,event.endMs);
					return;
				case 'output_transcript.added':
					this.#caption('assistant',event.item.text,false);
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
				const readback=this.#readback;
				if (this.#contextAligned && readback?.sealed && readback.receivedThrough!==undefined &&
					event.endMs!==undefined && event.endMs>readback.receivedThrough && /\bsubmit[?.!]*\s*$/iu.test(transcript)) {
					readback.spokenThrough=event.endMs;this.trace?.step('readback.completed');
				}
				this.#caption(role,transcript,true);
				if (bounded(transcript)) this.cb.onTranscript(role, transcript);
				return;
			}
			this.#completion(transcript,event.startMs,event.endMs);
		} catch { if (this.#live) { this.stop(); this.fail(new Error('Voice event failed')) } }
	}
}
