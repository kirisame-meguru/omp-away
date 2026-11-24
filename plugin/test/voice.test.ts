import { expect, test, vi } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVoiceTrace } from '../src/media/trace';
import type { LiveClientMessage, LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { VoiceSession, NoVoiceAudioError } from '../src/media/session';
import { LiveTransport } from '../src/media/live-sdk.generated.mjs';
import { logger } from '@oh-my-pi/pi-utils';
import { parseLiveServerEvent } from '../src/media/protocol';
import { openCallLog, type CallLog } from '../src/media/call-log';

const speech = new Uint8Array(960).fill(8), silence = new Uint8Array(960);
const final = (role: 'user' | 'assistant', transcript: string): LiveServerEvent => ({ type: 'turn.done', turn: { role, transcript } });
function harness(write?: () => void | Promise<void>, caption?: () => void, log?:CallLog) {
	const sent: LiveClientMessage[] = [], starts: string[] = [], transcripts: unknown[][] = [];
	const audio: Uint8Array[] = [], events: string[] = [], failures: Error[] = [], captions: unknown[][] = [];
	const session = new VoiceSession({
		onTranscript: (...args) => { transcripts.push(args) },
		onSpeechStarted: id => { starts.push(id); events.push('speech') },
		onAudio: frame => { audio.push(frame); return write?.() },
		onInterrupt: () => { events.push('interrupt') },
		onCaption: (...args) => { captions.push(args); caption?.() },
	}, async message => { sent.push(message) }, error => { failures.push(error) },undefined,log);
	return {session,sent,starts,transcripts,audio,events,failures,captions};
}
test('microphone energy waits for recognition while retaining the first sustained frame timestamp',async()=>{
	const starts:number[]=[];
	let now=100;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now);
	const session=new VoiceSession({onTranscript(){},onSpeechStarted(_id,at){starts.push(at!)},onAudio(){},onInterrupt(){}},async()=>{},()=>{});
	try {
		session.input(speech);now+=20;session.input(silence);
		expect(starts).toHaveLength(0);
		now=200;
		for(let i=0;i<3;i++){session.input(speech);now+=20}
		expect(starts).toHaveLength(0);
		now=900;
		await session.event({type:'unknown',wireType:'input_audio_buffer.speech_started'});
		expect(starts).toEqual([200]);
	} finally {session.stop();clock.mockRestore()}
});
test('quieter caller audio remains intact during loud handset output',()=>{
	let now=100;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness();
	const caller=new Uint8Array(960).fill(4), output=new Uint8Array(960).fill(64);
	try {
		expect(h.session.input(caller)).toBe(caller);
		h.session.rtp(output);
		for(let i=0;i<3;i++) {
			expect(h.session.input(caller)).toBe(caller);
			now+=20;
		}
		expect(caller.every(value=>value===4)).toBe(true);
		expect(h.starts).toEqual([]);
		now=501;
		expect(h.session.input(caller)).toBe(caller);
		expect(h.audio).toEqual([output]);
		expect(h.failures).toEqual([]);
	} finally {h.session.stop();clock.mockRestore()}
});
test('local transcript retains both speakers and unfinished turns without sending speech to logger sinks',async()=>{
	const root=await mkdtemp(join(tmpdir(),'away-speech-log-'));
	const info=vi.spyOn(logger,'info').mockImplementation(()=>{});
	const log=await openCallLog(root,'request','session');
	if(!log) throw Error('Transcript setup failed');
	const h=endpointHarness(undefined,undefined,log);
	try {
		h.session.input(speech);
		await h.partial('Bl',100,140);
		await h.partial('ue',140,200);
		await h.complete('Blue.',100,200);h.advance(75);
		await h.session.event(final('assistant','Shall I use Blue?'));
		await h.partial('Yes, but',300,400);
		await h.session.event(parseLiveServerEvent({type:'output_transcript.added',item:{text:'Let me'}})!);
		h.session.stop();
		await Promise.all([log.close(),log.close()]);
		const [file]=await readdir(root);
		const rows=Bun.JSONL.parse(await Bun.file(join(root,file)).text()) as {kind:string;role?:string;phase?:string;text?:string;bound?:boolean}[];
		expect(rows.filter(row=>row.kind==='speech').map(({role,phase,text})=>({role,phase,text}))).toEqual([
			{role:'user',phase:'delta',text:'Bl'},
			{role:'user',phase:'delta',text:'ue'},
			{role:'user',phase:'provider-final',text:'Blue.'},
			{role:'user',phase:'resolved-silence',text:'Blue.'},
			{role:'assistant',phase:'provider-final',text:'Shall I use Blue?'},
			{role:'user',phase:'delta',text:'Yes, but'},
			{role:'assistant',phase:'delta',text:'Let me'},
		]);
		expect(rows.find(row=>row.phase==='resolved-silence')?.bound).toBe(true);
		expect(rows.filter(row=>row.kind==='closed')).toHaveLength(1);
		for(const text of ['Blue.','Shall I use Blue?','Yes, but','Let me']) expect(JSON.stringify(info.mock.calls)).not.toContain(text);
		expect(h.failures).toEqual([]);
	} finally {h.close();await log.close();info.mockRestore();await rm(root,{recursive:true,force:true})}
});
function frames(session:VoiceSession, frame:Uint8Array, count:number) {
	for(let i=0;i<count;i++) session.rtp(frame);
}
function endpointHarness(write?:()=>void|Promise<void>,caption?:()=>void,log?:CallLog) {
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,'now').mockImplementation(()=>now), h=harness(write,caption,log);
	return {...h,
		async partial(text:string,start:number,end:number) {
			await h.session.event(parseLiveServerEvent({type:'input_transcript.added',start_ms:start,end_ms:end,item:{text}})!);
		},
		async complete(text:string,start:number,end:number) {
			await h.session.event(parseLiveServerEvent({type:'turn.done',turn:{role:'user',transcript:text,start_ms:start,end_ms:end}})!);
		},
		advance(count:number,pcm=silence) {
			for(let i=0;i<count;i++){now+=20;h.session.input(pcm);vi.advanceTimersByTime(20)}
		},
		elapse(ms:number) {now+=ms;vi.advanceTimersByTime(ms)},
		close() {h.session.stop();clock.mockRestore();vi.useRealTimers()},
	};
}
test('provider-final fragments preserve one correction until live microphone silence',async()=>{
	const h=endpointHarness();
	try {
		h.advance(3,speech);
		await h.partial('Wait stop.',100,200);
		await h.complete('Wait stop.',100,200);
		expect(h.transcripts).toEqual([]);
		h.advance(10,speech);
		await h.partial('I meant SQLite and Keep local.',300,600);
		await h.complete('I meant SQLite and Keep local.',300,600);
		expect(h.transcripts).toEqual([]);
		expect(h.starts).toHaveLength(1);
		h.advance(74);expect(h.transcripts).toEqual([]);
		h.advance(1);
		expect(h.transcripts).toEqual([['user','Wait stop. I meant SQLite and Keep local.',h.starts[0]]]);
		expect(h.failures).toEqual([]);
	} finally {h.close()}
});
test.each([false,true])('a finalized affirmative remains pending through its spoken qualifier, final=%s',async complete=>{
	const h=endpointHarness();
	try {
		h.advance(3,speech);
		await h.partial('Yes.',100,200);
		await h.complete('Yes.',100,200);
		h.advance(40);expect(h.transcripts).toEqual([]);
		h.advance(3,speech);
		await h.partial('But do not submit yet.',300,600);
		if(complete)await h.complete('But do not submit yet.',300,600);
		expect(h.transcripts).toEqual([]);
		h.advance(75);
		expect(h.transcripts).toEqual([['user','Yes. But do not submit yet.',h.starts[0]]]);
		expect(h.starts).toHaveLength(1);
	} finally {h.close()}
});
test.each(['overlapping-partial','regressing-final','earlier-onset'] as const)
('unusable %s after a finalized affirmative cannot authorize its retained prefix',async scenario=>{
	const h=endpointHarness();
	try {
		h.advance(3,speech);await h.partial('Yes.',100,200);await h.complete('Yes.',100,200);
		if(scenario==='overlapping-partial')await h.partial('But wait.',150,200);
		else if(scenario==='regressing-final')await h.complete('Wait.',100,150);
		else await h.complete('Yes.',50,200);
		if(h.failures.length)h.elapse(1500);else h.advance(75);
		expect(h.transcripts).toEqual([]);
	} finally {h.close()}
});
test('duplicate provider finals do not repeat words and a complete corrected final replaces the aggregate',async()=>{
	const h=endpointHarness();
	try {
		h.advance(3,speech);
		await h.partial('Wait.',100,200);
		await h.complete('Wait.',100,200);
		await h.complete('Wait.',100,200);
		h.advance(3,speech);
		await h.partial('Blue.',300,400);
		await h.complete('Wait.',100,200); // A repeated prefix final cannot erase the newer partial.
		await h.complete('Wait. Green.',100,400);
		expect(h.transcripts).toEqual([]);
		h.advance(75);
		expect(h.transcripts).toEqual([['user','Wait. Green.',h.starts[0]]]);
		expect(h.failures).toEqual([]);
	} finally {h.close()}
});
test.each(['overlap','unscoped'])('an unusable provider-final continuation cannot retain an affirmative prefix: %s',async kind=>{
	const h=endpointHarness();
	try {
		h.advance(3,speech);
		await h.partial('Yes.',100,200);
		await h.complete('Yes.',100,200);
		expect(h.transcripts).toEqual([]);
		if(kind==='overlap')await h.complete('but not yet',150,300);
		else await h.session.event(final('user','but not yet'));
		if(h.failures.length)h.elapse(1500);else h.advance(75);
		expect(h.transcripts).toEqual([]);
	} finally {h.close()}
});
test('quieter caller activity during playback cannot manufacture silence for a pending affirmative',async()=>{
	const h=endpointHarness(), caller=new Uint8Array(960).fill(4);
	try {
		await h.partial('Yes',100,200);
		for(let i=0;i<100;i++) {
			h.session.rtp(speech);
			h.advance(1,caller);
		}
		expect(h.transcripts).toEqual([]);
		h.advance(75);
		expect(h.transcripts).toEqual([['user','Yes',h.starts[0]]]);
	} finally {h.close()}
});
test('silence endpoint completes missing finals and late overlapping finals cannot consume the next answer',async()=>{
	const h=endpointHarness();
	try {
		h.session.input(speech); await h.partial('Coffee',100,200);
		h.advance(74); expect(h.transcripts).toEqual([]);
		h.advance(1); expect(h.transcripts).toEqual([['user','Coffee',h.starts[0]]]);
		expect(h.captions.at(-1)).toEqual(['user','Coffee',true]);
		h.session.input(speech); await h.partial('Yeah',300,400);
		await h.complete('Coffee',90,210);
		// One provider turn can span two locally ended utterances.
		await h.complete('Coffee Yeah',90,410);
		expect(h.transcripts).toHaveLength(1);
		h.advance(75);
		await h.partial('Yeah',300,400); expect(h.transcripts).toHaveLength(2);
		expect(h.transcripts).toEqual([['user','Coffee',h.starts[0]],['user','Yeah',h.starts[1]]]);
		await h.complete('Yeah',300,400); expect(h.transcripts).toHaveLength(2);
		expect(h.failures).toEqual([]);
	} finally {h.close()}
});
test('silence endpoint waits for continuing speech and includes a later negative qualifier',async()=>{
	const h=endpointHarness();
	try {
		h.session.input(speech); await h.partial('Yeah',100,200);
		h.advance(100,speech); expect(h.transcripts).toEqual([]);
		h.advance(50); h.session.input(speech); await h.partial(', but not yet.',300,500);
		h.advance(74); expect(h.transcripts).toEqual([]);
		h.advance(1); expect(h.transcripts).toEqual([['user','Yeah, but not yet.',h.starts[0]]]);
	} finally {h.close()}
});
test('silence endpoint needs live quiet microphone frames and is cancelled by hangup',async()=>{
	const h=endpointHarness();
	try {
		h.session.input(speech); await h.partial('Yeah',100,200);
		h.elapse(5000); expect(h.transcripts).toEqual([]);
		h.advance(74); expect(h.transcripts).toEqual([]);
		h.session.stop(); h.elapse(5000); expect(h.transcripts).toEqual([]);
	} finally {h.close()}
});
test('provider final replaces its partial correction but still waits for microphone silence',async()=>{
	const h=endpointHarness();
	try {
		h.session.input(speech); await h.partial('Yeah',120,190);
		await h.complete('No',100,200);
		expect(h.transcripts).toEqual([]);
		h.advance(75);
		expect(h.transcripts).toEqual([['user','No',h.starts[0]]]);
	} finally {h.close()}
});
test('an unscoped final after locally resolved speech fails closed instead of confirming a newer draft',async()=>{
	const h=endpointHarness();
	try {
		h.session.input(speech); await h.partial('Coffee',100,200); h.advance(75);
		h.session.input(speech); await h.partial('Yeah',300,400);
		await h.session.event(final('user','No'));
		h.elapse(5000);
		expect(h.failures).toHaveLength(1);
		expect(h.transcripts).toEqual([['user','Coffee',h.starts[0]]]);
	} finally {h.close()}
});
test('unscoped, malformed or oversize recognition cannot leave an affirmative prefix armed',async()=>{
	for(const next of [
		{type:'input_transcript.added',item:{text:', but wait'}},
		{type:'input_transcript.added',start_ms:300,end_ms:200,item:{text:', but wait'}},
		{type:'input_transcript.added',start_ms:200,end_ms:300,item:{text:'x'.repeat(8193)}},
	]) {
		const h=endpointHarness();
		try {
			h.session.input(speech); await h.partial('Yeah',100,200);
			await h.session.event(parseLiveServerEvent(next)!); h.advance(100);
			expect(h.transcripts).toEqual([]);
		} finally {h.close()}
	}
});
test('live captions coalesce deltas, replace provisional text with the final turn, and stop at hangup',async()=>{
	const h=endpointHarness();
	try {
		await h.partial('Cof',100,140);
		await h.partial('fee',140,200);
		await h.session.event({type:'output_transcript.added',item:{text:'Tea?'}});
		h.elapse(100);
		expect(h.captions).toEqual([['user','Coffee',false],['assistant','Tea?',false]]);
		expect(h.transcripts).toEqual([]);
		await h.complete('Coffee.',100,200);h.advance(75);
		expect(h.captions.at(-1)).toEqual(['user','Coffee.',true]);
		await h.partial('Yeah',300,400);
		h.elapse(100);
		expect(h.captions.at(-1)).toEqual(['user','Yeah',false]);
		await h.session.event({type:'output_transcript.added',item:{text:'More'}});
		const count=h.captions.length;
		h.session.stop(); vi.advanceTimersByTime(100);
		expect(h.captions).toHaveLength(count);
	} finally {h.close()}
});
test('failed caption delivery cannot stop audio or discard a final caller decision',async()=>{
	const h=endpointHarness(undefined,()=>{throw Error('Display unavailable')});
	try {
		await h.partial('Coffee',100,200);
		h.elapse(100);
		await h.complete('Coffee',100,200);h.advance(75);
		h.session.rtp(speech);
		expect(h.transcripts).toEqual([['user','Coffee',h.starts[0]]]);
		expect(h.audio).toEqual([speech]); expect(h.failures).toEqual([]);
	} finally {h.close()}
});
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
test('a validated readback has one speakable trigger after all preparation chunks',async()=>{
	const h=harness(), instruction='Read the proposed answers: '+JSON.stringify({fields:[{field:'Note',answer:'careful '.repeat(180)}]});
	try {
		await h.session.sendSpeakable(instruction,true);
		const context=h.sent.filter(message=>message.type==='session.context.append');
		const preparation=context.filter(message=>message.channel==='commentary');
		const speakable=context.filter(message=>message.channel==='speakable');
		expect(preparation.length).toBeGreaterThan(1);
		expect(preparation.flatMap(message=>message.content.map(part=>part.text)).join('')).toContain(instruction);
		expect(speakable).toHaveLength(1);
		expect(context.at(-1)).toBe(speakable[0]);
		for(const message of context) for(const part of message.content) expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(500);
		expect(h.failures).toEqual([]);
	} finally {h.session.stop()}
});
test('interruption during readback preparation cannot release a stale speakable trigger',async()=>{
	const h=harness();
	try {
		const pending=h.session.sendSpeakable('Proposed note: '+ 'careful '.repeat(180),true);
		await h.session.event({type:'unknown',wireType:'input_audio_buffer.speech_started'});
		await pending;
		expect(h.sent.filter(message=>message.type==='session.context.append' && message.channel==='speakable')).toEqual([]);
		expect(h.failures).toEqual([]);
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
	const h=endpointHarness();
	try {
		frames(h.session,speech,30); h.session.input(speech); const written=h.audio.length;
		await h.partial('Yes',100,200);
		await h.session.event({type:'unknown',wireType:'turn.interrupted'});
		h.elapse(1000);
		expect(h.audio).toHaveLength(written); expect(h.events).toEqual(['speech']);
		await h.complete('Yes.',100,200);h.advance(75);
		expect(h.transcripts).toEqual([['user','Yes.',h.starts[0]]]);
	} finally {h.close()}
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
	const h=endpointHarness(); try {
		h.advance(3,speech);h.advance(30);h.advance(3,speech);
		await h.partial('yes',100,200);expect(h.transcripts).toEqual([]);
		await h.complete('I choose green. The note is smoke test.',100,300);h.advance(75);
		expect(h.starts).toHaveLength(1); expect(h.transcripts[0][2]).toBe(h.starts[0]);
	} finally {h.close()}
});
test('duplicate provider speech starts cannot bind one affirmative',async()=>{
	const h=harness(), start:LiveServerEvent={type:'unknown',wireType:'input_audio_buffer.speech_started'};
	try {
		await h.session.event(start); await h.session.event(start); await h.session.event(final('user','Yes'));
		expect(h.transcripts).toEqual([]);expect(h.events).toContain('interrupt');expect(h.failures).toHaveLength(1);
	} finally {h.session.stop()}
});
test('untrusted delegation receives one terminal response without starting work or echoing its content',async()=>{
	const h=harness(), delegation:LiveServerEvent={type:'delegation.created',item:{id:'d',type:'delegation',target:'client',content:[{type:'input_text',text:'PRIVATE COMMAND'}]}};
	try {
		await h.session.event(delegation); await h.session.event(delegation);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({type:'delegation.context.append',delegation_item_id:'d'});
		// Stock /live uses the default channel for final results; commentary is progress only.
		expect(h.sent[0]).not.toHaveProperty('channel');
		expect(JSON.stringify(h.sent)).not.toContain('PRIVATE'); expect(h.events).toEqual([]);
		expect(h.transcripts).toEqual([]);
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
