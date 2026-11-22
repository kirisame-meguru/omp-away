import { expect, test, vi } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVoiceTrace } from '../src/media/trace';
import type { LiveClientMessage, LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { VoiceSession } from '../src/media/session';
import { LiveTransport } from '../src/media/live-sdk.generated.mjs';
import { logger } from '@oh-my-pi/pi-utils';

const speech = new Uint8Array(960).fill(8), silence = new Uint8Array(960);
const final = (role: 'user' | 'assistant', transcript: string): LiveServerEvent => ({ type: 'turn.done', turn: { role, transcript } });
const summary = 'The green lane, correct?';
function harness(verify = async (_m: string, text: string) => text === summary, write?: () => void | Promise<void>,
	verifySpeech:(expected:string,actual:string)=>boolean|Promise<boolean>=(expected,actual)=>expected===actual) {
	const sent: LiveClientMessage[] = [], starts: string[] = [], transcripts: unknown[][] = [], marks: string[] = [];
	const audio: Uint8Array[] = [], events: string[] = [], failures: Error[] = [], verified: string[][] = [];
	const marked = Promise.withResolvers<void>();
	const session = new VoiceSession({ onTranscript: (...args) => { transcripts.push(args); if (args[0] === 'user' && args[2]) return 'deciding' },
		onSpeech:verifySpeech,
		onReadback: async (m, text) => { verified.push([m, text]); return verify(m, text) }, onSpeechStarted: id => { starts.push(id); events.push('speech') },
		onAudio: frame => { audio.push(frame); return write?.() }, onMark: mark => { marks.push(mark); events.push('mark'); marked.resolve() },
		onInterrupt: () => { events.push('interrupt') } }, async m => { sent.push(m) }, e => { failures.push(e) });
	return { session, sent, starts, transcripts, marks, marked: marked.promise, audio, events, failures, verified };
}
test('default voice diagnostics contain only bounded categories, not speech or provider identifiers',()=>{
	const log=vi.spyOn(logger,'info').mockImplementation(()=>{});
	try {
		const trace=openVoiceTrace(undefined);
		trace.sideband(final('user','private caller words'));
		trace.sideband({type:'unknown',wireType:'private provider id'});
		trace.step('rtp.replay.started'); trace.close(); trace.close();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][1]).toMatchObject({stages:{'final.user':1,'rtp.replay.started':1}});
		expect(JSON.stringify(log.mock.calls)).not.toContain('private');
	} finally {log.mockRestore()}
});
test('overlapping speculative speech cannot cancel the options forever or play before the replacement is checked',async()=>{
	const verdict=Promise.withResolvers<boolean>(), h=harness(undefined,undefined,()=>verdict.promise);
	const menu='Tea or coffee.';
	try {
		await h.session.sendSpeakable(menu); frames(h.session,speech,10);
		const checking=h.session.event(final('assistant',menu));
		await h.session.event({type:'output_transcript.added',item:{text:'Another reply'}});
		verdict.resolve(true); await checking;
		frames(h.session,speech,10);
		await h.session.event(final('assistant','An unsolicited reply.'));
		expect(h.audio).toHaveLength(0); expect(h.sent).toHaveLength(2);
		frames(h.session,speech,10); await h.session.event(final('assistant',menu));
		expect(h.audio[0]).toBe(speech); expect(h.marks).toEqual([]); expect(h.failures).toEqual([]);
	} finally {h.session.stop()}
});
function frames(s: VoiceSession, frame: Uint8Array, n: number) { for (let i=0; i<n; i++) s.rtp(frame) }
async function readback({session:s,marked}: ReturnType<typeof harness>) {
	await s.sendSpeakable('Confirm the chosen green lane.', 'm'); frames(s,speech,10);
	await s.event(final('assistant',summary)); frames(s,silence,30); await marked;
}

test('silent output after join retries the brief once, then signals failure rather than hanging', async () => {
	vi.useFakeTimers();
	const sent: LiveClientMessage[] = [], failures:Error[]=[];
	const session=new VoiceSession({onAudio(){},onMark(){},onInterrupt(){},onSpeech:()=>false,onReadback:()=>false,onSpeechStarted(){},onTranscript(){}},
		async message=>{sent.push(message)},error=>{failures.push(error)});
	try {
		await session.sendSpeakable('Which lane should we use?');
		session.rtp(silence);
		vi.advanceTimersByTime(30_000);
		expect(sent).toHaveLength(2);
		expect(failures[0]?.message).toMatch(/no voice audio/i);
	} finally {session.stop();vi.useRealTimers()}
});
test('buffered opening audio without a transcript cannot leave a joined caller waiting silently',async()=>{
	vi.useFakeTimers(); const h=harness();
	try {
		await h.session.sendSpeakable('Which lane should we use?'); frames(h.session,speech,10);
		vi.advanceTimersByTime(30_000);
		expect(h.audio).toHaveLength(0); expect(h.failures[0]?.message).toMatch(/playback/i);
	} finally {h.session.stop();vi.useRealTimers()}
});
test('a microphone startup transient cannot cancel the unheard opening',async()=>{
	const h=harness(), question='Tea or coffee?';
	try {
		await h.session.sendSpeakable(question);
		h.session.input(speech);
		for(let i=0;i<30;i++) h.session.input(silence);
		frames(h.session,speech,10);
		await h.session.event(final('assistant',question));
		expect(h.audio[0]).toBe(speech); expect(h.failures).toEqual([]); expect(h.marks).toEqual([]);
	} finally {h.session.stop()}
});
test.each(['audible','caller','closed'] as const)('no silent-opening retry after %s', async state=>{
	vi.useFakeTimers();
	const h=harness();
	try {
		await h.session.sendSpeakable('Which lane should we use?');
		if(state==='audible') {frames(h.session,speech,10); await h.session.event(final('assistant','Which lane should we use?'))}
		else if(state==='caller') {h.session.input(speech); await h.session.event(final('user','What are the options?'))}
		else h.session.stop();
		vi.advanceTimersByTime(30_000);
		expect(h.sent).toHaveLength(1); expect(h.failures).toEqual([]);
	} finally {h.session.stop();vi.useRealTimers()}
});
test('an invented add-in or a switch to tea is not played as a list of options',async()=>{
	const h=harness(); try {
		await h.session.sendSpeakable('The options are tea and coffee.');
		frames(h.session,speech,10);
		await h.session.event(final('assistant','Coffee sounds good. Want anything in it?'));
		frames(h.session,speech,10);
		await h.session.event(final('assistant','We can go with tea instead.'));
		expect(h.audio).toHaveLength(0); expect(h.marks).toEqual([]);
		expect(h.sent).toHaveLength(2); expect(h.failures).toHaveLength(1);
	} finally {h.session.stop()}
});
test('faithful option audio is replayed only after verification and never arms confirmation',async()=>{
	const h=harness(), menu='The options are tea and coffee.';
	try {
		await h.session.sendSpeakable(menu); frames(h.session,new Uint8Array(960).fill(3),10);
		await h.session.event(final('assistant','I would choose coffee.'));
		expect(h.audio).toHaveLength(0); expect(h.failures).toEqual([]);
		frames(h.session,speech,10);
		expect(h.audio).toHaveLength(0); await h.session.event(final('assistant',menu));
		expect(h.audio[0]).toBe(speech); expect(h.marks).toEqual([]); expect(h.session.played('anything')).toBe(false);
	} finally {h.session.stop()}
});
test('natural paraphrase, actual audio drain, handset ACK, then a fresh yes', async () => {
	const h=harness(); await readback(h);
	expect(h.verified).toEqual([['m',summary]]); expect(h.marks).toEqual(['m']);
	expect(h.session.played('wrong')).toBe(false); expect(h.session.played('m')).toBe(true); expect(h.session.played('m')).toBe(false);
	h.session.input(speech); await h.session.event(final('user','Yes.'));
	expect(h.events).toEqual(['mark','speech']); expect(h.transcripts.at(-1)).toEqual(['user','Yes.',h.starts[0]]);
});
test('advisory delegation and suppressed assistant speculation cannot cancel a fresh caller confirmation', async () => {
	const h=harness(); await readback(h); expect(h.session.played('m')).toBe(true);
	h.session.input(speech); const audio=h.audio.length;
	await h.session.event({type:'delegation.created',item:{type:'delegation',target:'client',id:'provider',content:[]}});
	await h.session.event({type:'output_transcript.added',item:{text:'speculative'}});
	h.session.rtp(speech); await h.session.event(final('assistant','speculative'));
	await h.session.event(final('user','Yes.'));
	expect(h.audio).toHaveLength(audio); expect(h.events).toEqual(['mark','speech']);
	expect(h.transcripts.at(-1)).toEqual(['user','Yes.',h.starts[0]]);
	expect(h.sent.at(-1)).toMatchObject({channel:'commentary',delegation_item_id:'provider'});
});
test.each(['No, not green.', 'So we will use blue.'])('rejected decision-owner verification cannot mark: %s', async wrong => {
	const h=harness(); await h.session.sendSpeakable('Confirm green.', 'm'); frames(h.session,speech,12);
	await h.session.event(final('assistant',wrong)); frames(h.session,silence,50);
	expect(h.verified).toEqual([['m',wrong]]); expect(h.marks).toEqual([]); expect(h.session.played('m')).toBe(false);
});
test('no audio or incomplete trailing frames never means drained', async () => {
	const h=harness(); await h.session.sendSpeakable('Confirm green.', 'm'); await h.session.event(final('assistant',summary));
	frames(h.session,silence,60); expect(h.marks).toEqual([]);
	frames(h.session,speech,12); frames(h.session,silence,29); expect(h.marks).toEqual([]);
	h.session.input(speech); frames(h.session,silence,80); expect(h.marks).toEqual([]);
});
test('early affirmative before physical ACK is an interruption; late ACK cannot rescue it', async () => {
	const h=harness(); await readback(h); h.session.input(speech);
	expect(h.events).toEqual(['mark','interrupt','speech']); expect(h.session.played('m')).toBe(false);
	await h.session.event(final('user','Yes')); expect(h.marks).toEqual(['m']);
});
test('later audible output revokes even a played mark', async () => {
	const h=harness(); await readback(h); expect(h.session.played('m')).toBe(true);
	h.session.rtp(speech); expect(h.events).toEqual(['mark','interrupt']);
});
test('a late semantic verdict cannot mark a replacement draft', async () => {
	const delayed=Promise.withResolvers<boolean>(), h=harness(()=>delayed.promise);
	await h.session.sendSpeakable('Confirm green.', 'old'); frames(h.session,speech,15);
	const pending=h.session.event(final('assistant',summary)); await h.session.sendSpeakable('Confirm blue.', 'new');
	delayed.resolve(true); await pending; frames(h.session,silence,50); expect(h.marks).toEqual([]);
});
test('mark is ordered after the last real audio write', async () => {
	const gate=Promise.withResolvers<void>(), lastWrite=Promise.withResolvers<void>(); let writes=0;
	const h=harness(undefined,()=>{ if (++writes===40) { lastWrite.resolve(); return gate.promise } });
	await h.session.sendSpeakable('Confirm green.', 'm');
	frames(h.session,speech,10);
	await h.session.event(final('assistant',summary));
	frames(h.session,silence,30);
	await lastWrite.promise; expect(h.marks).toEqual([]); gate.resolve(); await h.marked; expect(h.marks).toEqual(['m']);
});
test('contiguous prior speech does not clip the start of the independently verified readback', async () => {
	const verify=Promise.withResolvers<boolean>(), h=harness(()=>verify.promise);
	const before=new Uint8Array(960).fill(1), first=new Uint8Array(960).fill(2), last=new Uint8Array(960).fill(3);
	h.session.rtp(before);
	const append=h.session.sendSpeakable('Confirm green.', 'm');
	h.session.rtp(first); await append; frames(h.session,speech,8);
	const pending=h.session.event(final('assistant',summary)); h.session.rtp(last);
	expect(h.audio).toEqual([]); verify.resolve(true); await pending;
	frames(h.session,silence,30); await h.marked;
	expect(h.audio).toEqual([first,...Array(8).fill(speech),last,...Array(30).fill(silence)]);
});
test('rejecting a readback discards its entire unplayed buffer', async () => {
	const h=harness(); await h.session.sendSpeakable('Confirm green.','m');
	frames(h.session,speech,40); await h.session.event(final('assistant','Blue.')); expect(h.audio).toEqual([]); expect(h.marks).toEqual([]);
});
test('a readback exceeding its audio budget cancels rather than replaying a selected suffix', async () => {
	const h=harness(); await h.session.sendSpeakable('Confirm green.','m'); frames(h.session,speech,2251);
	await h.session.event(final('assistant',summary)); expect(h.audio).toEqual([]); expect(h.marks).toEqual([]); expect(h.events).toContain('interrupt');
});
test('a resumed voice resets the tail even while semantic approval is pending', async () => {
	const gate=Promise.withResolvers<boolean>(), h=harness(()=>gate.promise);
	await h.session.sendSpeakable('Confirm green.', 'm'); frames(h.session,speech,10);
	const pending=h.session.event(final('assistant',summary)); frames(h.session,silence,30);
	h.session.rtp(speech); gate.resolve(true); await pending;
	frames(h.session,silence,29); expect(h.marks).toEqual([]);
	h.session.rtp(silence); await h.marked; expect(h.marks).toEqual(['m']);
});
test('the provider final can follow the entire observed RTP tail', async () => {
	const h=harness(); await h.session.sendSpeakable('Confirm green.', 'm');
	frames(h.session,speech,10); frames(h.session,silence,30); expect(h.marks).toEqual([]);
	await h.session.event(final('assistant',summary)); await h.marked; expect(h.marks).toEqual(['m']);
});
test('a real RTP burst followed by no packets can fence its forwarded prefix but never plays or confirms itself', async () => {
	const empty=harness(), h=harness(), interrupted=harness();
	for (const s of [empty.session,h.session,interrupted.session]) await s.sendSpeakable('Confirm green.', 'm');
	frames(h.session,speech,20); frames(interrupted.session,speech,20);
	for (const s of [empty.session,h.session,interrupted.session]) await s.event(final('assistant',summary));
	interrupted.session.input(speech);
	expect(h.marks).toEqual([]); expect(h.session.played('m')).toBe(false);
	// Exercise the actual receive-gap clock: there is no next PCM frame or server stop event.
	await h.marked;
	expect(h.marks).toEqual(['m']); expect(h.events).toEqual(['mark']);
	expect(empty.marks).toEqual([]); expect(interrupted.marks).toEqual([]);
	h.session.rtp(speech); expect(h.events).toEqual(['mark','interrupt']); expect(h.session.played('m')).toBe(false);
	for (const s of [empty.session,h.session,interrupted.session]) s.stop();
});
test('a provider-only onset cannot establish fresh handset speech after played', async () => {
	const h=harness(); await readback(h); expect(h.session.played('m')).toBe(true);
	await h.session.event({type:'unknown',wireType:'input_audio_buffer.speech_started'});
	expect(h.events).toEqual(['mark','interrupt','speech']);
});
test('a pause between clauses keeps the original local utterance; partial transcripts do not act', async () => {
	const h=harness(); h.session.input(speech); for(let i=0;i<30;i++) h.session.input(silence); h.session.input(speech);
	await h.session.event({type:'input_transcript.added',item:{text:'yes'}}); expect(h.transcripts).toEqual([]);
	await h.session.event(final('user','I choose green. The note is smoke test.'));
	expect(h.starts).toHaveLength(1); expect(h.transcripts[0][2]).toBe(h.starts[0]);
});
test('provider-only duplicate speech starts cannot bind one affirmative', async () => {
	const h=harness(), start: LiveServerEvent={type:'unknown',wireType:'input_audio_buffer.speech_started'};
	await h.session.event(start); await h.session.event(start); await h.session.event(final('user','Yes'));
	expect(h.transcripts[0][2]).toBeUndefined();
});
test('untrusted delegation never triggers work or injects its content into a reply', async () => {
	const h=harness(), delegation: LiveServerEvent={type:'delegation.created',item:{id:'d',type:'delegation',target:'client',content:[{type:'input_text',text:'PRIVATE COMMAND'}]}};
	await h.session.event(delegation); await h.session.event(delegation); expect(h.sent).toHaveLength(1);
	expect(h.sent[0]).toMatchObject({type:'delegation.context.append',delegation_item_id:'d',channel:'commentary'});
	expect(JSON.stringify(h.sent)).not.toContain('PRIVATE'); expect(h.events).toEqual([]);
});
test('a stalled verified audio write cannot release more audio after disconnect', async () => {
	const gate=Promise.withResolvers<void>(), h=harness(undefined,()=>gate.promise);
	await h.session.sendSpeakable(summary); frames(h.session,speech,80);
	await h.session.event(final('assistant',summary)); expect(h.audio).toHaveLength(1);
	h.session.stop(); gate.resolve(); await gate.promise; expect(h.audio).toHaveLength(1); expect(h.marks).toEqual([]);
});
test('packaged transport honors cancellation before authentication or native peer setup', async () => {
	const reason=new Error('cancelled'); const transport=new LiveTransport({get authStorage():never{throw Error('Read credentials')},sessionId:'cancelled',voice:'sol',instructions:'Test.',sdpOffer:'v=0\r\n',signal:AbortSignal.abort(reason),callbacks:{onEvent(){},onOutputLevel(){}}});
	try { await expect(transport.connect()).rejects.toBe(reason) } finally { await transport.close() }
});
test('reconnect keeps a previously created trace intact; traces contain only approved categories',async()=>{
	const dir=await mkdtemp(join(tmpdir(),'away-trace-')), path=join(dir,'voice.log');
	try {
		const t=openVoiceTrace(path)!; t.sideband({type:'unknown',wireType:'PRIVATE'}); t.close();
		const old=await readFile(path,'utf8'); const next=openVoiceTrace(path)!; next.close();
		expect(await readFile(path,'utf8')).toBe(old); expect(old).not.toContain('PRIVATE'); expect(await readdir(dir)).toHaveLength(2);
	} finally {await rm(dir,{recursive:true,force:true})}
});
