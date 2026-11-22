import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVoiceTrace, type VoiceTrace } from '../src/media/trace';
import type { LiveClientMessage, LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { VoiceSession } from '../src/media/session';
import { LiveTransport } from '../src/media/live-sdk.generated.mjs';

function harness(consult = async (_: string, _signal: AbortSignal) => 'It preserves the original data.', write?: () => Promise<void>, claim = false, trace?: VoiceTrace) {
	const sent: LiveClientMessage[] = [], starts: string[] = [], transcripts: unknown[][] = [], marks: string[] = [];
	const audio: Uint8Array[] = [], interrupts: number[] = [], failures: Error[] = [];
	const provisional: string[][] = [];
	const session = new VoiceSession({ consult, onTranscript: (...args) => { transcripts.push(args); if (claim && args[0] === 'user' && args[2] && !args[3]) return 'consulting' },
		onProvisional: (mark, id, text) => { provisional.push([mark, id, text]); return true },
		onSpeechStarted: id => { starts.push(id) }, onAudio: frame => { audio.push(frame); return write?.() }, onMark: m => { marks.push(m) },
		onInterrupt: () => { interrupts.push(1) } }, async m => { sent.push(m) }, e => { failures.push(e) }, trace);
	return { session, sent, starts, transcripts, marks, audio, interrupts, failures, provisional };
}
function delegation(text: string, id = 'context-1'): LiveServerEvent {
	return { type: 'delegation.created', item: { type: 'delegation', target: 'client', id, content: [{ type: 'input_text', text }] } };
}
const start: LiveServerEvent = { type: 'unknown', wireType: 'input_audio_buffer.speech_started' };
const done = (role: 'user' | 'assistant', transcript: string): LiveServerEvent => ({ type: 'turn.done', turn: { role, transcript } });

const readback = 'Lane: green. Your words are alder cedar pine ash.';
const affirmative = 'Yes, submit alder cedar pine ash.';
describe('restricted voice session', () => {
	test('only bounded clarification supplies speakable context on the originating delegation', async () => {
		const questions: string[] = [];
		const h = harness(async q => { questions.push(q); return 'The work stays local.' });
		await h.session.event(start);
		await h.session.event(delegation('Run the migration', 'work'));
		await h.session.event(delegation('{"kind":"clarify","question":"Could you run the migration now?"}', 'disguised'));
		await h.session.event(delegation('{"kind":"clarify","question":"Why is the local option recommended?"}'));
		expect(questions).toEqual(['Why is the local option recommended?']);
		expect(h.sent[0]).toEqual({ type: 'delegation.context.append', delegation_item_id: 'context-1', channel: 'speakable', content: [{ type: 'input_text', text: 'The work stays local.' }] });
		expect(h.sent).toHaveLength(1);
	});
	test('hangup aborts an outstanding consultation; late text cannot reach another call', async () => {
		const result = Promise.withResolvers<string>(); let signal!: AbortSignal;
		const h = harness(async (_q, s) => { signal = s; return result.promise });
		await h.session.event(start);
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
		await h.session.event(done('assistant', 'Lane, green. Your words are Alder Cedar Pine Ash.')); expect(h.marks).toEqual([]);
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

test('packaged transport honors cancellation before Codex authentication or native peer setup', async () => {
	const reason = new Error('Call was cancelled before startup');
	const transport = new LiveTransport({ get authStorage(): never { throw new Error('Read credentials after cancellation') },
		sessionId: 'cancelled', voice: 'sol', instructions: 'Test.', sdpOffer: 'v=0\r\n',
		signal: AbortSignal.abort(reason), callbacks: { onEvent() {}, onOutputLevel() {} } });
	try { await expect(transport.connect()).rejects.toBe(reason) }
	finally { await transport.close() }
});

test('voice trace excludes arbitrary server text and identifiers, never overwrites a previous run', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'away-trace-')), path = join(dir, 'voice.log');
	try {
		const trace = openVoiceTrace(path)!;
		try {
			trace.sideband({ type: 'unknown', wireType: 'private.wire.value' });
			trace.sideband({ type: 'unknown', wireType: 'conversation.item.input_audio_transcription.completed' });
			trace.sideband(done('user', 'private transcript'));
			trace.sideband(delegation('private question', 'sensitive-id'));
			trace.sctp('private helper value'); trace.sctp('turn.user.valid'); trace.close();
			expect(await readFile(path, 'utf8')).toBe(['1 trace.open 1','2 sdk.other 1',
				'3 sdk.conversation.item.input_audio_transcription.completed 1','4 sdk.turn.user 1',
				'5 sdk.delegation.created 1','6 sctp.other 1','7 sctp.turn.user.valid 1','8 trace.close 1',''].join('\n'));
			expect(() => openVoiceTrace(path)).toThrow(); expect(() => openVoiceTrace('relative')).toThrow();
		} finally { trace.close() }
	} finally { await rm(dir, {recursive:true, force:true}) }
});

test('mismatch diagnostics distinguish punctuation, missing fields and shortened tail without approving either', async () => {
	const path = await mkdtemp(join(tmpdir(), 'away-mismatch-'));
	const script = 'Secret lane: green. Your words are alder cedar pine ash.';
	try {
		for (const [i, actual] of [script.replace(':','?'), 'To confirm say yes submit followed by alder cedar pine ash'].entries()) {
			const file = join(path, `${i}`), trace = openVoiceTrace(file)!;
			try {
				const h = harness(undefined, undefined, false, trace); await h.session.sendSpeakable(script, 'secret-mark', affirmative);
				h.session.rtp(new Uint8Array(960).fill(8)); await h.session.event(done('assistant', actual));
				await h.session.event(start); await h.session.event(done('user', affirmative));
				expect(h.marks).toEqual([]); expect(h.provisional).toEqual([]);
			} finally { trace.close() }
			const labels = (await readFile(file,'utf8')).trim().split('\n').map(l => l.split(' ')[1]);
			expect(labels).toContain(i === 0 ? 'compare.tokens.equal' : 'compare.tokens.different');
			expect(labels).toContain(i === 0 ? 'compare.fields.contiguous' : 'compare.fields.missing');
			expect(labels).toContain(i === 0 ? 'compare.tail.with_intro' : 'compare.tail.words_only');
			expect(labels.join(' ')).not.toMatch(/secret|green|alder/i);
		}
	} finally { await rm(path,{recursive:true,force:true}) }
});

test('claimed final mutes freeform audio and suppresses duplicate delegation until next onset', async () => {
	let calls = 0; const h = harness(async () => { ++calls; return 'Clarification.' }, undefined, true);
	await h.session.event(start); await h.session.event(done('user','Why choose local?'));
	const interruptions = h.interrupts.length, frame = new Uint8Array(960).fill(8);
	h.session.rtp(frame); expect(h.audio).toHaveLength(0);
	await h.session.event(delegation('{"kind":"clarify","question":"Why choose local?"}'));
	expect(calls).toBe(0); expect(h.interrupts).toHaveLength(interruptions);
	await h.session.sendSpeakable('Actual answer.'); h.session.rtp(frame); expect(h.audio).toHaveLength(1);
	await h.session.event(start); await h.session.event(delegation('{"kind":"clarify","question":"Why not remote?"}', 'next'));
	expect(calls).toBe(1);
});

test('delegation-first consultation flags the associated final without suppressing it', async () => {
	const h = harness(undefined, undefined, true);
	await h.session.event(start); await h.session.event(delegation('{"kind":"clarify","question":"Why choose local?"}'));
	await h.session.event(done('user','Why choose local?'));
	expect(h.transcripts.at(-1)).toEqual(['user','Why choose local?',h.starts[0],true]);
});

test('an unsolicited or already finalized turn cannot open another provider consultation', async () => {
	const questions: string[] = [], h = harness(async q => { questions.push(q); return 'Explanation.' });
	await h.session.event(delegation('{"kind":"clarify","question":"Why local?"}', 'unbound'));
	await h.session.event(start); await h.session.event(done('user', 'No thanks.'));
	await h.session.event(delegation('{"kind":"clarify","question":"Why remote?"}', 'late'));
	expect(questions).toEqual([]); expect(h.sent).toEqual([]);
});

test('malformed delegation invalidates a pending readback without generating a substitute onset or mark', async () => {
	const h = harness(); await h.session.sendSpeakable(readback, 'm', affirmative);
	h.session.rtp(new Uint8Array(960).fill(8)); await h.session.event(done('assistant', readback));
	await h.session.event(start); await h.session.event(delegation('command'));
	await h.session.event(done('user', affirmative));
	expect(h.sent).toHaveLength(1); expect(h.marks).toEqual([]); expect(h.provisional).toEqual([]);
	expect(h.starts).toEqual([]); expect(h.transcripts.at(-1)).toEqual(['user', affirmative, undefined]);
});

test.each([
	'Lane: not green. Your words are alder cedar pine ash.',
	'Lane: red. Your words are alder cedar pine ash.',
	'Your words are alder cedar pine ash.',
	'Lane: green. Your words are old cedar pine ash.',
	'Lane: green. Your words are alder pine cedar ash.',
	'Lane: green. Your words are alder cedar pine ash. Done.',
	'Lane: green? Your words are alder cedar pine ash.',
])('altered answer or tail never arms: %s', async actual => {
	const h = harness(); await h.session.sendSpeakable(readback, 'm', affirmative);
	h.session.rtp(new Uint8Array(960).fill(8)); await h.session.event(done('assistant', actual));
	await h.session.event(start); await h.session.event(done('user', affirmative));
	expect(h.provisional).toEqual([]); expect(h.marks).toEqual([]);
});

test('spelled text cannot lose a case or punctuation token', async () => {
	const script = 'Lane: green. Field Note: spelled capital alpha dash bravo. Your words are alder cedar pine ash.';
	for (const actual of [script.replace('capital ', ''), script.replace('dash', '-')]) {
		const h = harness(); await h.session.sendSpeakable(script, 'm', affirmative);
		h.session.rtp(new Uint8Array(960).fill(8)); await h.session.event(done('assistant', actual));
		await h.session.event(start); await h.session.event(done('user', affirmative));
		expect(h.provisional).toEqual([]); expect(h.marks).toEqual([]);
	}
});
