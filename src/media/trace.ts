import { closeSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';

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
const steps = ['onset.local','onset.provider','onset.paired','onset.ambiguous','interrupt','speech.started.callback','final.user.bound','final.user.unbound','final.assistant.callback','final.invalid',
	'compare.tokens.equal','compare.tokens.different','compare.length.equal','compare.length.shorter','compare.length.longer','compare.fields.contiguous','compare.fields.ordered_only','compare.fields.missing',
	'compare.tail.with_intro','compare.tail.words_only','compare.tail.different','consult.claimed','consult.duplicate','consult.delegation_first',
	'canonical.match','canonical.mismatch','speakable.requested','speakable.sent','readback.requested','readback.sent','consult.dispatched','consult.refused','consult.sent','provisional.accepted','provisional.rejected','mark.emitted','voice.ready'] as const;
export interface VoiceTrace {
	step(event: typeof steps[number]): void;
	sideband(event: LiveServerEvent): void;
	sctp(category: unknown): void;
	close(): void;
}

/** Only the desktop operator supplies this path. No file/stream/callback when disabled.
 * New local file per call; ensure its directory has a private ACL on Windows. */
export function openVoiceTrace(path: string | undefined): VoiceTrace | undefined {
	if (path === undefined || path === '') return;
	if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || (process.platform === 'win32' &&
		(!/^[A-Za-z]:[\\/]/.test(path) || /[:]/.test(path.slice(2)) || /(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.\\/]|$)/i.test(path)))) throw new Error('Voice trace needs a fresh absolute local file');
	let fd: number | undefined;
	try { fd = openSync(path, 'ax', 0o600) } catch { throw new Error('Cannot create fresh voice trace') }
	const counts = new Map<string, number>();
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
			writeSync(fd, `${seq} ${seq === 4096 ? 'trace.limit' : category} ${count}\n`);
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
