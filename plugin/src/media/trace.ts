import { closeSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { logger } from '@oh-my-pi/pi-utils';

// Only exact members are ever persisted. In particular a server can choose arbitrary 'type',
// item ID, role or payload; a regex for plausible-looking names is NOT a safe allowlist.
const wire = [
	'session.started','session.updated','session.created','output_audio.delta','input_transcript.added','output_transcript.added','delegation.created','error',
	'input_audio_buffer.speech_started','input_audio_buffer.speech_stopped','input_audio_buffer.committed','output_audio_buffer.started','output_audio_buffer.stopped','output_audio_buffer.cleared',
	'conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.delta','conversation.item.input_audio_transcription.failed',
	'response.output_audio_transcript.done','response.output_audio_transcript.delta','response.audio_transcript.done','response.audio_transcript.delta',
	'response.output_audio.done','response.output_audio.delta','response.output_item.done','conversation.item.done','conversation.item.created','response.created','response.done','response.cancelled','turn.interrupted',
];
const peerShapes = ['binary','oversize','invalid','turn.user.valid','turn.assistant.valid','turn.user.missing_transcript','turn.assistant.missing_transcript','turn.missing_turn','turn.other_role','transcript.missing_text'];
const steps = ['endpoint.user','caption.delivery_failed','onset.local','onset.provider','interrupt','speech.started.callback','final.user.bound','final.user.unbound',
	'onset.rebound','context.unaligned','readback.completed',
	'rtp.replay.started','rtp.replay.limit','rtp.first_voiced','rtp.voice.none','rtp.voice.partial','rtp.voice.enough',
	'rtp.quiet.none','rtp.quiet.partial','rtp.quiet.enough','rtp.writes.pending','rtp.writes.drained','rtp.receive.idle','rtp.receive.recent',
	'rtp.end.quiet_frames','rtp.end.receive_gap','rtp.end.quiet_gap',
	'speakable.first_voiced','speakable.retry','speakable.no_audio','speakable.waiting',
	'consult.claimed','decision.claimed','readback.verified','readback.rejected','speakable.sent','readback.sent','mark.emitted','mark.played','voice.ready'] as const;
export interface VoiceTrace {
	step(event: typeof steps[number]): void;
	sideband(event: LiveServerEvent): void;
	sctp(category: unknown): void;
	close(): void;
}

/** Always retain a bounded category-only summary; detailed traces require an operator path.
 * No text, audio, identifiers, or arbitrary provider event names enter either output. */
export function openVoiceTrace(path: string | undefined): VoiceTrace {
	if (path === undefined || path === '') {
		const counts:Record<string,number> = {};
		const started=performance.now();
		let closed=false;
		const count=(name:string)=>{if(!closed) counts[name]=Math.min((counts[name]??0)+1,65535)};
		return {
			step(event) {if(steps.includes(event)) count(event)},
			sideband(event) {
				if(event.type==='turn.done') count(event.turn.role==='user' ? 'final.user' : 'final.assistant');
				else if(event.type==='input_transcript.added') count('partial.user');
				else if(event.type==='output_transcript.added') count('partial.assistant');
				else if(event.type==='error') count('provider.error');
			},
			sctp() {},
			close() {
				if(closed) return;
				closed=true;
				logger.info('Away voice summary', {elapsedMs:Math.round(performance.now()-started),stages:counts});
			},
		};
	}
	if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || (process.platform === 'win32' &&
		(!/^[A-Za-z]:[\\/]/.test(path) || /[:]/.test(path.slice(2)) || /(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.\\/]|$)/i.test(path)))) throw new Error('Voice trace needs a fresh absolute local file');
	let fd: number | undefined;
	try { fd = openSync(path, 'ax', 0o600) } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot create voice trace');
		// Never append to or replace an existing path, including on reconnect.
		try { fd = openSync(`${path}.${crypto.randomUUID()}`, 'ax', 0o600) } catch { throw new Error('Cannot create separate voice trace') }
	}
	const counts = new Map<string, number>();
	const openedAt = performance.now();
	let seq = 0;
	function release() {
		if (fd === undefined) return;
		const handle = fd; fd = undefined;
		try { closeSync(handle) } catch { /* Diagnostics never change call state. */ }
	}
	function record(category: string) {
		if (fd === undefined) return;
		const count = (counts.get(category) ?? 0) + 1; counts.set(category, count);
		// Hot events are counters, not a per-token/per-frame time series.
		if ((category.endsWith('.delta') || category.endsWith('.added') || category.endsWith('.other')) && (count & (count - 1)) !== 0) return;
		try {
			++seq;
			writeSync(fd, `${seq} ${seq === 4096 ? 'trace.limit' : category} ${count} ${Math.floor(performance.now() - openedAt)}\n`);
			if (seq === 4096) release();
		} catch { release() }
	}
	record('trace.open');
	return {
		step(e) { if (steps.includes(e)) record(e) },
		sideband(e) {
			if (e.type === 'turn.done') { record(e.turn.role === 'user' ? 'sdk.turn.user' : e.turn.role === 'assistant' ? 'sdk.turn.assistant' : 'sdk.other'); return }
			const name = e.type === 'unknown' ? e.wireType : e.type;
			record(wire.includes(name) ? `sdk.${name}` : 'sdk.other');
		},
		sctp(e) { record(typeof e === 'string' && (peerShapes.includes(e) || wire.includes(e)) ? `sctp.${e}` : 'sctp.other') },
		close() { record('trace.close'); release() },
	};
}
