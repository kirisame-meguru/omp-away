import { describe, expect, test } from 'bun:test';
import type { LiveClientMessage, LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { VoiceSession } from '../src/media/session';

function harness(consult = async (_: string, _signal: AbortSignal) => 'It preserves the original data.', write?: () => Promise<void>) {
	const sent: LiveClientMessage[] = [], starts: string[] = [], transcripts: unknown[][] = [], marks: string[] = [];
	const audio: Uint8Array[] = [], interrupts: number[] = [], failures: Error[] = [];
	const provisional: string[][] = [];
	const session = new VoiceSession({ consult, onTranscript: (...args) => { transcripts.push(args) },
		onProvisional: (mark, id, text) => { provisional.push([mark, id, text]); return true },
		onSpeechStarted: id => { starts.push(id) }, onAudio: frame => { audio.push(frame); return write?.() }, onMark: m => { marks.push(m) },
		onInterrupt: () => { interrupts.push(1) } }, async m => { sent.push(m) }, e => { failures.push(e) });
	return { session, sent, starts, transcripts, marks, audio, interrupts, failures, provisional };
}
function delegation(text: string, id = 'context-1'): LiveServerEvent {
	return { type: 'delegation.created', item: { type: 'delegation', target: 'client', id, content: [{ type: 'input_text', text }] } };
}
const start: LiveServerEvent = { type: 'unknown', wireType: 'input_audio_buffer.speech_started' };
const done = (role: 'user' | 'assistant', transcript: string): LiveServerEvent => ({ type: 'turn.done', turn: { role, transcript } });

const readback = 'Choose local? To confirm say yes, submit, followed by these words. Your words are alder cedar pine ash.';
const affirmative = 'Yes, submit alder cedar pine ash.';
describe('restricted voice session', () => {
	test('only bounded clarification supplies speakable context on the originating delegation', async () => {
		const questions: string[] = [];
		const h = harness(async q => { questions.push(q); return 'The work stays local.' });
		await h.session.event(delegation('{"kind":"clarify","question":"Why is the local option recommended?"}'));
		await h.session.event(delegation('Run the migration', 'work'));
		await h.session.event(delegation('{"kind":"clarify","question":"Could you run the migration now?"}', 'disguised'));
		expect(questions).toEqual(['Why is the local option recommended?']);
		expect(h.sent[0]).toEqual({ type: 'delegation.context.append', delegation_item_id: 'context-1', channel: 'speakable', content: [{ type: 'input_text', text: 'The work stays local.' }] });
		expect(h.sent[1]).toMatchObject({ type: 'delegation.context.append', delegation_item_id: 'work' });
	});
	test('hangup aborts an outstanding consultation; late text cannot reach another call', async () => {
		const result = Promise.withResolvers<string>(); let signal!: AbortSignal;
		const h = harness(async (_q, s) => { signal = s; return result.promise });
		const pending = h.session.event(delegation('{"kind":"clarify","question":"What does this option mean?"}'));
		h.session.stop(); expect(signal.aborted).toBe(true); result.resolve('late'); await pending;
		expect(h.sent).toEqual([]);
	});
	test('negative speech is final exactly once and carries only the corresponding speech-start id', async () => {
		const h = harness(); await h.session.event(start);
		await h.session.event({ type: 'input_transcript.added', item: { text: 'yes' } });
		expect(h.transcripts).toEqual([]);
		await h.session.event(done('user', 'No')); expect(h.starts).toHaveLength(1);
		expect(h.transcripts).toEqual([['user', 'No', h.starts[0]]]);
		await h.session.event(done('user', 'yes')); expect(h.transcripts[1]).toEqual(['user', 'yes', undefined]);
	});
	test('a sideband transcript and arbitrary RTP audio never prove the end of a specific readback', async () => {
		const h = harness(); await h.session.sendSpeakable(readback, 'm', affirmative);
		h.session.rtp(new Uint8Array(960)); await h.session.event(done('assistant', readback));
		expect(h.marks).toEqual([]);
	});
	test('barge-in revokes the mark before any asynchronous delivery', async () => {
		const h = harness(); await h.session.sendSpeakable(readback, 'm', affirmative);
		await h.session.event(start); await h.session.event(done('assistant', readback));
		expect(h.interrupts).toHaveLength(1); expect(h.marks).toEqual([]);
	});
	test('complete exact readback and subsequent tail receipt mark once, subject to decision approval', async () => {
		const h = harness(); await h.session.sendSpeakable(readback, 'm', affirmative);
		const frame = new Uint8Array(960); frame.fill(8); h.session.rtp(frame);
		await h.session.event(done('assistant', readback)); expect(h.marks).toEqual([]);
		await h.session.event(start); await h.session.event(done('user', affirmative));
		expect(h.provisional).toHaveLength(1); expect(h.marks).toEqual(['m']); expect(h.starts).toEqual([]);
		await h.session.event(done('user', affirmative)); expect(h.marks).toEqual(['m']);
	});
	test('paraphrase, early speech, and a late affirmative after interruption cannot arm', async () => {
		const h = harness(); await h.session.sendSpeakable(readback, 'm', affirmative);
		await h.session.event(done('assistant', 'Choose remote instead. Your words are alder cedar pine ash.'));
		await h.session.event(start); await h.session.event(done('user', affirmative));
		expect(h.provisional).toEqual([]); expect(h.marks).toEqual([]);
	});
	test('local mic onset cuts old RTP; negative speech while waiting for a receipt is still actionable', async () => {
		const h = harness(), frame = new Uint8Array(960).fill(8);
		await h.session.sendSpeakable(readback, 'm', affirmative); h.session.rtp(frame);
		await h.session.event(done('assistant', readback)); h.session.input(frame); h.session.rtp(frame);
		await h.session.event(done('user', 'No, discard that.'));
		expect(h.audio).toHaveLength(1); expect(h.starts).toHaveLength(1);
		expect(h.transcripts.at(-1)).toEqual(['user', 'No, discard that.', h.starts[0]]);
		expect(h.marks).toEqual([]); expect(h.provisional).toEqual([]);
	});
	test('more than one provider onset invalidates binding, even with a matching final', async () => {
		const h = harness(); await h.session.sendSpeakable(readback, 'm', affirmative);
		h.session.rtp(new Uint8Array(960).fill(8)); await h.session.event(done('assistant', readback));
		await h.session.event(start); await h.session.event(start); await h.session.event(done('user', affirmative));
		expect(h.marks).toEqual([]); expect(h.provisional).toEqual([]);
	});
	test('waits for accepted output writes before issuing the authenticated phone drain request', async () => {
		const drain = Promise.withResolvers<void>(), h = harness(undefined, () => drain.promise);
		await h.session.sendSpeakable(readback, 'm', affirmative);
		h.session.rtp(new Uint8Array(960).fill(8)); await h.session.event(done('assistant', readback));
		await h.session.event(start); const pending = h.session.event(done('user', affirmative));
		expect(h.marks).toEqual([]); drain.resolve(); await pending; expect(h.marks).toEqual(['m']);
	});
	test('stalled output fails the call without issuing a mark or replaying queued frames', async () => {
		const drain = Promise.withResolvers<void>(), h = harness(undefined, () => drain.promise);
		await h.session.sendSpeakable(readback, 'm', affirmative);
		const frame = new Uint8Array(960).fill(8);
		for (let i = 0; i < 100; i++) h.session.rtp(frame);
		drain.resolve(); await h.session.event(done('assistant', readback));
		await h.session.event(start); await h.session.event(done('user', affirmative));
		expect(h.audio).toHaveLength(1); expect(h.failures).toHaveLength(1); expect(h.marks).toEqual([]);
	});
});
