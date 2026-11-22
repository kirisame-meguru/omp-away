import { expect, test, vi } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVoiceTrace } from '../src/media/trace';
import type { LiveClientMessage, LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { VoiceSession, NoVoiceAudioError } from '../src/media/session';
import { LiveTransport } from '../src/media/live-sdk.generated.mjs';
import { logger } from '@oh-my-pi/pi-utils';

const speech = new Uint8Array(960).fill(8), silence = new Uint8Array(960);
const final = (role: 'user' | 'assistant', transcript: string): LiveServerEvent => ({ type: 'turn.done', turn: { role, transcript } });
function harness(write?: () => void | Promise<void>) {
	const sent: LiveClientMessage[] = [], starts: string[] = [], transcripts: unknown[][] = [];
	const audio: Uint8Array[] = [], events: string[] = [], failures: Error[] = [];
	const session = new VoiceSession({
		onTranscript: (...args) => { transcripts.push(args) },
		onSpeechStarted: id => { starts.push(id); events.push('speech') },
		onAudio: frame => { audio.push(frame); return write?.() },
		onInterrupt: () => { events.push('interrupt') },
	}, async message => { sent.push(message) }, error => { failures.push(error) });
	return {session,sent,starts,transcripts,audio,events,failures};
}
function frames(session:VoiceSession, frame:Uint8Array, count:number) {
	for(let i=0;i<count;i++) session.rtp(frame);
}
test('audio reaches the handset before any assistant final or verification',async()=>{
	const h=harness();
	try {
		await h.session.sendSpeakable('Tea or coffee?'); h.session.rtp(speech);
		expect(h.audio).toHaveLength(1); expect(h.audio[0]).toBe(speech);
		expect(h.transcripts).toEqual([]);
	} finally {h.session.stop()}
});
test('new speech instructions do not wait for a previous response to finish',async()=>{
	const h=harness();
	try {
		await h.session.event({type:'output_transcript.added',item:{text:'Previous reply'}});
		void h.session.sendSpeakable('Coffee. Submit?',true);
		expect(h.sent).toHaveLength(1);
	} finally {h.session.stop()}
});
test('ordered audio deltas stream every frame without requiring an assistant transcript',async()=>{
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness();
	try {
		const chunks=Array.from({length:10},(_,i)=>new Uint8Array(960).fill(i+2));
		await h.session.event({type:'output_audio.delta',audio:Buffer.concat(chunks).toString('base64')});
		expect(h.audio.length).toBeGreaterThan(0);
		for(let i=0;i<10;i++){now+=20;vi.advanceTimersByTime(20)}
		expect(h.audio).toEqual(chunks); expect(h.transcripts).toEqual([]); expect(h.failures).toEqual([]);
	} finally {h.session.stop();clock.mockRestore();vi.useRealTimers()}
});
test.each(['AQ==','AQ','*'])('invalid ordered audio fails the call instead of reaching the phone: %s',async audio=>{
	const h=harness(); try {
		await h.session.event({type:'output_audio.delta',audio});
		expect(h.audio).toEqual([]); expect(h.failures).toHaveLength(1);
		h.session.rtp(speech); expect(h.audio).toEqual([]);
	} finally {h.session.stop()}
});
test('late timers deliver the whole utterance on its sample clock rather than stretching every frame',async()=>{
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness();
	try {
		frames(h.session,speech,50);
		expect(h.audio.length).toBeLessThanOrEqual(6);
		for(let i=0;i<30;i++){now+=31;vi.advanceTimersByTime(31)}
		expect(h.audio).toHaveLength(50); expect(h.failures).toEqual([]);
	} finally {h.session.stop();clock.mockRestore();vi.useRealTimers()}
});
test('a long host stall preserves every frame without flooding the handset queue',async()=>{
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness();
	try {
		frames(h.session,speech,100); const before=h.audio.length;
		now+=2000;vi.advanceTimersByTime(20);
		expect(h.audio.length-before).toBeLessThanOrEqual(6);
		for(let i=0;i<100;i++){now+=20;vi.advanceTimersByTime(20)}
		expect(h.audio).toHaveLength(100); expect(h.failures).toEqual([]);
	} finally {h.session.stop();clock.mockRestore();vi.useRealTimers()}
});
test('streaming longer than the old whole-response budget releases consumed frames',()=>{
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness();
	try {
		for(let i=0;i<2300;i++){h.session.rtp(speech);now+=20;vi.advanceTimersByTime(20)}
		expect(h.audio).toHaveLength(2300); expect(h.failures).toEqual([]);
	} finally {h.session.stop();clock.mockRestore();vi.useRealTimers()}
});
test('warmup silence is limited to the small pre-roll rather than replayed for seconds',()=>{
	const h=harness(); try {
		frames(h.session,silence,500); expect(h.audio).toEqual([]);
		h.session.rtp(speech);
		expect(h.audio).toEqual([...Array(5).fill(silence),speech]);
	} finally {h.session.stop()}
});
test.each(['before','during'] as const)('microphone startup %s streaming cannot cut the opening',async when=>{
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness();
	try {
		await h.session.sendSpeakable('Tea or coffee?');
		if(when==='before') h.session.input(speech);
		frames(h.session,speech,10);
		if(when==='during') h.session.input(speech);
		for(let i=0;i<12;i++){now+=20;vi.advanceTimersByTime(20)}
		expect(h.audio).toHaveLength(10); expect(h.failures).toEqual([]);
	} finally {h.session.stop();clock.mockRestore();vi.useRealTimers()}
});
test('recognized caller speech discards queued old audio without erasing the confirmation onset',async()=>{
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness();
	try {
		frames(h.session,speech,30); h.session.input(speech); const written=h.audio.length;
		await h.session.event({type:'input_transcript.added',item:{text:'Yes'}});
		await h.session.event({type:'unknown',wireType:'turn.interrupted'});
		now+=1000;vi.advanceTimersByTime(1000);
		expect(h.audio).toHaveLength(written); expect(h.events).toEqual(['speech']);
		await h.session.event(final('user','Yes.'));
		expect(h.transcripts).toEqual([['user','Yes.',h.starts[0]]]);
	} finally {h.session.stop();clock.mockRestore();vi.useRealTimers()}
});
test('no audio reports a transport failure, without adding a silent retry or affecting a working stream',async()=>{
	vi.useFakeTimers(); const missing=harness(), working=harness();
	try {
		await missing.session.sendSpeakable('Tea or coffee?');
		await working.session.sendSpeakable('Tea or coffee?'); working.session.rtp(speech);
		vi.advanceTimersByTime(10_000);
		expect(missing.failures[0]).toBeInstanceOf(NoVoiceAudioError); expect(missing.sent).toHaveLength(1);
		expect(working.audio).toHaveLength(1); expect(working.failures).toEqual([]);
	} finally {missing.session.stop();working.session.stop();vi.useRealTimers()}
});
test('a stalled audio write cannot release queued audio after disconnect',async()=>{
	const gate=Promise.withResolvers<void>(), h=harness(()=>gate.promise);
	try {
		frames(h.session,speech,80); expect(h.audio).toHaveLength(1);
		h.session.stop(); gate.resolve(); await gate.promise;
		expect(h.audio).toHaveLength(1); expect(h.failures).toEqual([]);
	} finally {gate.resolve();h.session.stop()}
});
test('backpressure is bounded and closes the stream rather than dropping a selected suffix',async()=>{
	const gate=Promise.withResolvers<void>(), h=harness(()=>gate.promise);
	try {
		frames(h.session,speech,300);
		expect(h.audio).toHaveLength(1); expect(h.failures.map(e=>e.message)).toEqual(['Handset audio delivery stalled']);
		gate.resolve(); await gate.promise; expect(h.audio).toHaveLength(1);
	} finally {gate.resolve();h.session.stop()}
});
test('a pause between clauses keeps one caller turn; partial transcripts never act',async()=>{
	const h=harness(); try {
		h.session.input(speech); for(let i=0;i<30;i++) h.session.input(silence); h.session.input(speech);
		await h.session.event({type:'input_transcript.added',item:{text:'yes'}}); expect(h.transcripts).toEqual([]);
		await h.session.event(final('user','I choose green. The note is smoke test.'));
		expect(h.starts).toHaveLength(1); expect(h.transcripts[0][2]).toBe(h.starts[0]);
	} finally {h.session.stop()}
});
test('duplicate provider speech starts cannot bind one affirmative',async()=>{
	const h=harness(), start:LiveServerEvent={type:'unknown',wireType:'input_audio_buffer.speech_started'};
	try {
		await h.session.event(start); await h.session.event(start); await h.session.event(final('user','Yes'));
		expect(h.transcripts[0][2]).toBeUndefined(); expect(h.events).toContain('interrupt');
	} finally {h.session.stop()}
});
test('untrusted delegation never triggers work or injects its content into a reply',async()=>{
	const h=harness(), delegation:LiveServerEvent={type:'delegation.created',item:{id:'d',type:'delegation',target:'client',content:[{type:'input_text',text:'PRIVATE COMMAND'}]}};
	try {
		await h.session.event(delegation); await h.session.event(delegation);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({type:'delegation.context.append',delegation_item_id:'d',channel:'commentary'});
		expect(JSON.stringify(h.sent)).not.toContain('PRIVATE'); expect(h.events).toEqual([]);
	} finally {h.session.stop()}
});
test('packaged transport honors cancellation before authentication or native peer setup',async()=>{
	const reason=new Error('cancelled'); const transport=new LiveTransport({get authStorage():never{throw Error('Read credentials')},sessionId:'cancelled',voice:'sol',instructions:'Test.',sdpOffer:'v=0\r\n',signal:AbortSignal.abort(reason),callbacks:{onEvent(){},onOutputLevel(){}}});
	try {await expect(transport.connect()).rejects.toBe(reason)} finally {await transport.close()}
});
test('default diagnostics contain only bounded categories, not speech or provider identifiers',()=>{
	const log=vi.spyOn(logger,'info').mockImplementation(()=>{});
	try {
		const trace=openVoiceTrace(undefined); trace.sideband(final('user','private caller words'));
		trace.sideband({type:'unknown',wireType:'private provider id'}); trace.step('rtp.replay.started'); trace.close(); trace.close();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][1]).toMatchObject({stages:{'final.user':1,'rtp.replay.started':1}});
		expect(JSON.stringify(log.mock.calls)).not.toContain('private');
	} finally {log.mockRestore()}
});
test('reconnect preserves existing traces and excludes private event names',async()=>{
	const dir=await mkdtemp(join(tmpdir(),'away-trace-')), path=join(dir,'voice.log');
	try {
		const trace=openVoiceTrace(path)!; trace.sideband({type:'unknown',wireType:'PRIVATE'}); trace.close();
		const old=await readFile(path,'utf8'); const next=openVoiceTrace(path)!; next.close();
		expect(await readFile(path,'utf8')).toBe(old); expect(old).not.toContain('PRIVATE'); expect(await readdir(dir)).toHaveLength(2);
	} finally {await rm(dir,{recursive:true,force:true})}
});
