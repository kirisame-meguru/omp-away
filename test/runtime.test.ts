import { expect, test, vi } from "bun:test";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { gatewayConfigured, openAdmin } from "../src/runtime";
import type { PendingAsk } from "../src";
import type { DesktopControl, SecureDesktopOptions } from "../src/secure-channel";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import { VoiceSession } from "../src/media/session";
import type { openVoice, VoiceOptions } from "../src/media";
import { connectRuntime, type AskContext } from "../src/runtime/routing";
import { Enrollment } from "../src/runtime/enrollment";
import { awaySuggestions } from "../src/runtime/commands";
import { parseLiveServerEvent } from "../src/media/protocol";

const pcm = new Uint8Array(960);
const blueFields='{"fields":[{"name":"lane","value":"blue","evidence":"Blue"}]}';
async function fixture(consultAnswer:()=>Promise<string> = async()=>"The private handover is silver maple.", voice?:typeof openVoice, stateDir="") {
	let wire!: SecureDesktopOptions;
	const voices: VoiceOptions[] = [], spoken: {text:string;instruction:boolean}[] = [], sideCalls:string[]=[];
	const audioIn: Uint8Array[] = [], audioOut: string[] = [], rings: string[][] = [], submitted: unknown[] = [];
	const controls: {device:string; message:DesktopControl}[] = [];
	const consultations: {tools:boolean;promptText:string;signal:AbortSignal}[]=[];
	const runtime = await connectRuntime({ url:"https://example.invalid", desktopToken:"", stateDir, confirmPair:async()=>false }, {away:false,delayMs:null}, () => {}, {
		async gateway(options) { wire = options; return {
			async devices(){return ["phone"]}, async pair(){throw Error("unexpected enrollment")}, async close(){},
			async ring(dev,id){rings.push([dev,id])},
			async sendControl(device,message){
				controls.push({device,message});
			},
			async sendPcm(device){audioOut.push(device)},
		} },
		async voice(options) { voices.push(options); if (voice) return voice(options); return {
			sendPcm(data){audioIn.push(data)}, async sendSpeakable(text,instruction=false){spoken.push({text,instruction})}, async close(){},
		} },
	});
	const ctx = { cwd:"/example/project", sessionManager:{getSessionId:()=>"session"},modelRegistry:{}, async runEphemeralTurn(opt:{purpose:string;tools:boolean;promptText:string;signal:AbortSignal}) {
		sideCalls.push(opt.purpose);
		if (opt.purpose==="away-consult") consultations.push(opt);
		const replyText=opt.purpose==="away-extract" ? blueFields : opt.purpose==="away-consult" ? await consultAnswer() : "Which lane should we use?";
		return {assistantMessage:{stopReason:"stop"}, replyText};
	} } as unknown as AskContext;
	const offer = (id:string,html='<form><label for="l">Private lane?</label><select name="lane" id="l"><option value="blue">Blue</option><option value="red">Red</option></select></form>') => runtime.offer({requestId:id,toolCallId:`tool-${id}`,html, async submitConfirmed(id,values){submitted.push([id,values]);return "accepted"} } satisfies PendingAsk,ctx);
	const join = (dev:string,id:string) => wire.onMessage(dev,{type:"join",requestId:id});
	return {runtime,wire,voices,spoken,controls,rings,audioIn,audioOut,submitted,offer,join,consultations,sideCalls};
}
test('captions go only to the opted-in active caller and cannot authorize submission',async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A");
		await f.wire.onMessage("phone",{type:"join",requestId:"A",captions:true});
		const voice=f.voices[0];
		voice.onCaption?.("user","Coffee",false);
		voice.onCaption?.("assistant","Submitting",true);
		expect(f.controls.filter(c=>c.message.type==="transcript")).toEqual([
			{device:"phone",message:{type:"transcript",requestId:"A",role:"user",text:"Coffee",final:false}},
			{device:"phone",message:{type:"transcript",requestId:"A",role:"assistant",text:"Submitting",final:true}},
		]);
		expect(f.submitted).toEqual([]);
		await f.wire.onMessage("phone",{type:"hangup",requestId:"A"});
		voice.onCaption?.("user","late speech",true);
		expect(f.controls.filter(c=>c.message.type==="transcript")).toHaveLength(2);
		f.offer("B"); await f.join("phone","B");
		expect(f.voices[1].onCaption).toBeUndefined();
	} finally {await f.runtime.close()}
});
test("birth pins the audience; decline, stale and unauthenticated join never open voice or ring",async()=>{
	const f=await fixture(); try {
		f.offer("request-A"); f.wire.onConnect!("phone"); f.wire.onMessage("phone",{type:"silence",requestId:"request-A"});
		f.runtime.configure({away:true,delayMs:null}); f.wire.onPcm("phone",pcm); f.join("unknown","request-A");
		f.wire.onConnect!("new-phone"); f.join("new-phone","request-A"); f.wire.onMessage("new-phone",{type:"list"});
		f.runtime.end("request-A"); f.join("phone","request-A"); await tick();
		expect(f.rings).toEqual([]); expect(f.voices).toHaveLength(0); expect(f.audioIn).toHaveLength(0);
		expect(JSON.stringify(f.controls.filter(c=>c.device==="new-phone"))).not.toContain("Private lane");
		f.offer("request-B"); expect(f.rings.sort()).toEqual([["new-phone","request-B"],["phone","request-B"]]);
	} finally {await f.runtime.close()}
});
test("disconnect, hangup and desktop win fence old media and marks; reconnect reconciles the inbox",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); f.join("phone","A"); await tick();
		const old=f.voices[0]; expect(f.controls.some(c=>c.message.type==="joined" && c.message.requestId==="A")).toBe(true);
		f.wire.onPcm("phone",pcm); old.onAudio(pcm); expect(f.audioIn).toHaveLength(1); expect(f.audioOut).toEqual(["phone"]);
		f.wire.onLoss("phone"); expect(old.signal?.aborted).toBe(true); f.wire.onConnect!("phone"); f.wire.onMessage("phone",{type:"list"});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"inbox",items:[{requestId:"A"}]});
		old.onAudio(pcm); f.wire.onPcm("phone",pcm); expect(f.audioIn).toHaveLength(1); expect(f.audioOut).toHaveLength(1);
		f.join("phone","A"); await tick(); const second=f.voices[1]; f.wire.onMessage("phone",{type:"hangup",requestId:"A"}); expect(second.signal?.aborted).toBe(true);
		f.join("phone","A"); await tick(); f.runtime.end("A"); f.offer("B"); f.join("phone","A"); old.onTranscript("user","Yes", "outdated"); await tick();
		expect(f.voices).toHaveLength(3); expect(f.submitted).toEqual([]); expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
	} finally {await f.runtime.close()}
});
test("a greeting after joining repeats the pending question without proposing or submitting",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
		const opening=f.spoken[0];
		expect(opening.text).toContain("Private lane?");
		expect(opening.text).toContain("Blue");
		expect(opening.text).toContain("Red");
		expect(opening.instruction).toBe(false);
		const v=f.voices[0]; v.onSpeechStarted("g"); v.onTranscript("user","Hello, hello.","g"); await tick();
		expect(f.spoken.slice(1)).toEqual([opening]);
		v.onSpeechStarted("y"); v.onTranscript("user","Yeah.","y"); await tick();
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("explicit confirmation submits without an assistant final, model verification or handset acknowledgment",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("draft"); v.onTranscript("user","Blue.","draft"); await tick();
		expect(f.spoken.at(-1)?.instruction).toBe(true); expect(f.submitted).toEqual([]);
		await f.wire.onMessage("phone",{type:"played",requestId:"A",mark:"obsolete"});
		expect(f.submitted).toEqual([]);
		v.onSpeechStarted("confirm"); v.onTranscript("user","Yes.","confirm"); v.onTranscript("user","Yes.","confirm"); await tick();
		expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
		expect(f.sideCalls).toEqual([]); expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
	} finally {await f.runtime.close()}
});
test.each(["interrupt","hangup","lost","negative"])("a proposal followed by %s cannot submit",async action=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("draft"); v.onTranscript("user","Blue.","draft"); await tick();
		if(action==="interrupt") v.onInterrupt();
		if(action==="hangup") await f.wire.onMessage("phone",{type:"hangup",requestId:"A"});
		if(action==="lost") f.wire.onLoss("phone");
		v.onSpeechStarted("next"); v.onTranscript("user",action==="negative"?"No.":"Yes.","next"); await tick();
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("corrections replace the pending values and obsolete handset messages cannot change them",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("first"); v.onTranscript("user","Blue.","first"); await tick();
		v.onSpeechStarted("correction"); v.onTranscript("user","Red.","correction"); await tick();
		await f.wire.onMessage("phone",{type:"played",requestId:"A",mark:"old"});
		v.onTranscript("assistant","Yes."); expect(f.submitted).toEqual([]);
		v.onSpeechStarted("yes"); v.onTranscript("user","Yes.","yes"); await tick();
		expect(f.submitted).toEqual([["A",{lane:"red"}]]); expect(f.sideCalls).toEqual([]);
	} finally {await f.runtime.close()}
});
test("bound informational speech consults the coding session without a model delegation or a submission",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
		const v=f.voices[0], question="What were the two handover words from the session?";
		v.onTranscript("assistant",question); v.onTranscript("user",question,"missing-onset");
		v.onSpeechStarted("one"); v.onTranscript("user",question,"one"); v.onTranscript("user",question,"one");
		await tick(); expect(f.consultations).toHaveLength(1); expect(f.consultations[0].tools).toBe(false);
		expect(f.consultations[0].promptText).toContain(question); expect(f.spoken.slice(1)).toEqual([{text:"The private handover is silver maple.",instruction:false}]);
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test.each([
	"Ask the main model to come up with some other two drinks",
	"Could you please ask the main model for two other drinks?",
	"Please suggest two alternative drinks.",
])("informational request answers the caller without approving the previous draft: %s",async request=>{
	const answer="Water and orange juice are two other ideas; the form still lists Tea and Coffee.";
	const f=await fixture(async()=>answer);
	try {
		f.wire.onConnect!("phone");
		f.offer("A",'<form><fieldset><legend>Which drink would you like?</legend><label><input type="radio" name="drink" value="tea">Tea</label><label><input type="radio" name="drink" value="coffee">Coffee</label></fieldset></form>');
		await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("proposal"); v.onTranscript("user","Coffee","proposal"); await tick();
		v.onSpeechStarted("request"); v.onTranscript("user",request,"request"); await tick();
		expect(f.spoken.at(-1)).toEqual({text:answer,instruction:false});
		expect(f.sideCalls).toEqual(["away-consult"]);
		expect(f.consultations[0].tools).toBe(false);
		expect(f.consultations[0].promptText).toContain(request);
		v.onSpeechStarted("yes"); v.onTranscript("user","Yes","yes"); await tick();
		expect(f.submitted).toEqual([]);
		v.onSpeechStarted("fresh"); v.onTranscript("user","Coffee","fresh"); await tick();
		v.onSpeechStarted("confirm"); v.onTranscript("user","Yes","confirm"); await tick();
		expect(f.submitted).toEqual([["A",{drink:"coffee"}]]);
	} finally {await f.runtime.close()}
});
async function realVoiceFixture(stateDir=""){
	const sent:LiveClientMessage[]=[], failures:Error[]=[];
	let session!:VoiceSession;
	const f=await fixture(undefined,async options=>{
		session=new VoiceSession(options,async m=>{sent.push(m)},err=>{failures.push(err);options.onEnd(err)},undefined,options.log);
		return {sendPcm:pcm=>session.input(pcm),sendSpeakable:(text,instruction)=>session.sendSpeakable(text,instruction),async close(){session.stop()}};
	},stateDir);
	f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
	return {...f,session,sent,failures};
}
test("asking for the options lists the enabled native labels without favoring one or proposing a change",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
		const v=f.voices[0]; v.onSpeechStarted("proposal"); v.onTranscript("user","Blue.","proposal"); await tick();
		v.onSpeechStarted("q"); v.onTranscript("user","What are the options?","q"); await tick();
		expect(f.spoken.at(-1)).toEqual({text:"The options are: Blue; Red.",instruction:false});
		v.onSpeechStarted("yes"); v.onTranscript("user","Yes.","yes"); await tick();
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test.each(["recorded","unwritable","write-failed"])("real voice accepts Yeah after abort with a %s transcript destination",async mode=>{
	const root=await mkdtemp(join(tmpdir(),"away-call-outcome-")), blocked=join(root,"blocked");
	if(mode==="unwritable") await Bun.write(blocked,"not a directory");
	const f=await realVoiceFixture(mode==="unwritable"?blocked:root), speech=new Uint8Array(960).fill(8);
	const failure=mode==="write-failed" ? vi.spyOn(fs.WriteStream.prototype,"write").mockImplementationOnce(function(this:fs.WriteStream){this.destroy(Error("disk write failed"));return false}) : undefined;
	try {
		f.session.rtp(speech); await tick(); expect(f.audioOut).toEqual(["phone"]);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Blue."}}); await tick();
		for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);
		f.session.rtp(speech); await tick();
		expect(f.submitted).toEqual([]); expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"unknown",wireType:"turn.interrupted"});
		await f.session.event({type:"turn.done",turn:{role:"assistant",transcript:"Okay, submitting."}});
		expect(f.submitted).toEqual([]);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Yeah..."}}); await tick();
		expect(f.failures).toEqual([]); expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
		expect(f.sideCalls).toEqual([]);
		expect(f.voices[0].signal?.aborted).toBe(true);
		expect(f.controls.filter(c=>c.message.type==="ended")).toEqual([{device:"phone",message:{type:"ended",requestId:"A"}}]);
		expect(f.controls.at(-1)?.message).toEqual({type:"inbox",items:[]});
		expect(()=>f.session.input(speech)).toThrow("Invalid voice input");
		await f.runtime.close();
		const files:string[]=[];
		for await(const file of new Bun.Glob("calls/*.jsonl").scan(root)) files.push(file);
		if(mode==="recorded") {
			expect(files).toHaveLength(1); expect(files[0]).not.toContain(".active.");
			const rows=Bun.JSONL.parse(await Bun.file(join(root,files[0])).text()) as {kind:string;stage?:string;reply?:string;phase?:string;text?:string}[];
			const ended=rows.findIndex(row=>row.stage==="ended"), accepted=rows.findIndex(row=>row.reply==="accepted");
			expect(ended).toBeGreaterThan(-1); expect(accepted).toBeGreaterThan(ended);
			expect(rows.findIndex(row=>row.kind==="closed")).toBeGreaterThan(accepted);
			expect(rows.filter(row=>row.phase==="resolved-provider").map(row=>row.text)).toEqual(["Blue.","Yeah..."]);
		} else if(mode==="unwritable") expect(files).toEqual([]);
		else {expect(failure).toHaveBeenCalled();expect(files).toHaveLength(1);expect(files[0]).toEndWith(".active.jsonl")}
	} finally {failure?.mockRestore();await f.runtime.close();await rm(root,{recursive:true,force:true})}
});
test("missing provider finals still require a new affirmative and submit the native draft exactly once",async()=>{
	vi.useFakeTimers(); let now=0;
	const clock=vi.spyOn(performance,"now").mockImplementation(()=>now), f=await realVoiceFixture();
	const speech=new Uint8Array(960).fill(8);
	const quiet=(count:number)=>{for(let i=0;i<count;i++){now+=20;f.wire.onPcm("phone",pcm);vi.advanceTimersByTime(20)}};
	const say=async(text:string,start:number)=>{
		f.wire.onPcm("phone",speech);
		await f.session.event(parseLiveServerEvent({type:"input_transcript.added",item:{text},start_ms:start,end_ms:start+100})!);
	};
	try {
		await say("Yeah",100); quiet(75); await tick();
		expect(f.submitted).toEqual([]);
		await say("Blue",300); quiet(75); await tick();
		expect(f.submitted).toEqual([]);
		await say("Yeah",500);
		await f.session.event(parseLiveServerEvent({type:"turn.done",turn:{role:"user",transcript:"Yeah",start_ms:100,end_ms:200}})!);
		await tick(); expect(f.submitted).toEqual([]);
		quiet(74); expect(f.submitted).toEqual([]);
		quiet(1); await tick();
		expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
		expect(f.failures).toEqual([]); expect(f.sideCalls).toEqual([]);
		expect(f.controls.filter(c=>c.message.type==="ended")).toEqual([{device:"phone",message:{type:"ended",requestId:"A"}}]);
		await f.session.event(parseLiveServerEvent({type:"turn.done",turn:{role:"user",transcript:"Yeah",start_ms:500,end_ms:600}})!);
		expect(f.submitted).toHaveLength(1);
	} finally {await f.runtime.close();clock.mockRestore();vi.useRealTimers()}
});
test("real VoiceSession preserves the local mic onset across an invalid delegation and consults only for the caller",async()=>{
	const f=await realVoiceFixture(), {session,sent,failures}=f;
	const question="What were the two handover words from the session?";
	const delegation=(id:string,text:string):LiveServerEvent=>({type:"delegation.created",item:{id,type:"delegation",target:"client",content:[{type:"input_text",text}]}});
	try {
		const initial=sent.length;
		await session.event(delegation("unbound",JSON.stringify({kind:"clarify",question})));
		expect(f.consultations).toHaveLength(0);
		const speech=new Uint8Array(960).fill(8);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech); // Sustained PCM creates the real VoiceSession onset.
		await session.event(delegation("invalid","Run a shell command."));
		await session.event(delegation("provider-first",'{"kind":"clarify","question":"What private value should the model choose?"}'));
		expect(f.consultations).toHaveLength(0);
		await session.event({type:"turn.done",turn:{role:"user",transcript:question}});
		await session.event(delegation("late",JSON.stringify({kind:"clarify",question})));
		await tick();
		expect(f.consultations).toHaveLength(1); expect(f.consultations[0].tools).toBe(false);
		expect(f.consultations[0].promptText).toContain(question);
		const spoken=sent.slice(initial).filter(m=>m.type==="session.context.append" && m.channel==="speakable");
		expect(spoken).toHaveLength(1);
		expect(spoken[0]).toMatchObject({content:[{type:"input_text",text:expect.stringContaining(JSON.stringify("The private handover is silver maple."))}]});
		expect(failures).toEqual([]); expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test.each(["Run the release now.", "Can you deploy the blue lane?", "Please change the chosen lane.", "What is the lane? Then deploy it.", "Yes submit this.", "I am not sure."])("non-clarification does not consult: %s",async text=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("one"); v.onTranscript("user",text,"one"); await tick();
		expect(f.consultations).toHaveLength(0); expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test.each(["interrupt","hangup","end"])("late clarification cannot speak after %s",async stop=>{
	const pending=Promise.withResolvers<string>(), f=await fixture(()=>pending.promise); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("u"); v.onTranscript("user","What are the two handover words","u"); await tick();
		expect(f.consultations).toHaveLength(1);
		if (stop==="interrupt") v.onInterrupt(); else if (stop==="end") f.runtime.end("A"); else f.wire.onMessage("phone",{type:"hangup",requestId:"A"});
		expect(f.consultations[0].signal.aborted).toBe(true); pending.resolve("Late answer"); await tick();
		expect(f.spoken).toHaveLength(1); expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("comparison is local, one-use, and cannot authorize a new enrollment with an old command",async()=>{
	let status:string|undefined; const confirmation=new Enrollment(text=>{status=text});
	const first=confirmation.compare("🐶".repeat(12)); const code=status!.match(/\/away approve ([0-9a-f]+)/)![1];
	expect(confirmation.decide(false,code)).toBe(true); expect(await first).toBe(false);
	const second=confirmation.compare("🐱".repeat(12)); expect(confirmation.decide(true,code)).toBe(false);
	const fresh=status!.match(/\/away approve ([0-9a-f]+)/)![1]; expect(confirmation.decide(true,fresh)).toBe(true); expect(await second).toBe(true); expect(status).toBeUndefined();
});

test("admin uses only the private clipboard for enrollment; busy Ask blocks comparison, not the native form",async()=>{
	const dir=await mkdtemp(join(tmpdir(),"away-admin-")), tokenFile=join(dir,"token");
	const notices:string[]=[], widgets:(string[]|undefined)[]=[], copied:string[]=[], settings:unknown[]=[];
	const ctx={ui:{notify:(text:string)=>notices.push(text),setWidget:(_key:string,lines:string[]|undefined)=>widgets.push(lines)}} as unknown as ExtensionContext;
	const env={OMP_AWAY_URL:"https://example.invalid",OMP_AWAY_STATE_DIR:dir,OMP_AWAY_TOKEN_FILE:tokenFile};
	let confirm!:SecureDesktopOptions["confirmPair"], pairs=0, idle=true;
	try {
		await writeFile(tokenFile,Buffer.alloc(32,7).toString("base64url"),{mode:0o600});
		const admin=await openAdmin(ctx,()=>true,()=>idle,{env,copy:async payload=>{copied.push(payload)},async connect(options){
			confirm=options.confirmPair;
			return {offer(){},end(){},async close(){},configure(next){settings.push(next)},async pair(){pairs++;return '{"secret":"test-only-enrollment"}'}};
		}});
		try {
			await admin!.command("fallback 30"); await admin!.command(""); await admin!.command("off");
			expect(settings).toEqual([{away:false,delayMs:30_000},{away:true,delayMs:30_000},{away:false,delayMs:30_000}]);
			await admin!.command("fallback off"); expect(JSON.parse(await readFile(join(dir,"routing.json"),"utf8"))).toEqual({away:false,delayMs:null});
			idle=false;await admin!.command("pair");expect(pairs).toBe(0);expect(await confirm("phone","🐶".repeat(12))).toBe(false);
			idle=true;await admin!.command("pair");expect(copied).toEqual(['{"secret":"test-only-enrollment"}']);
			const comparison=confirm("phone","🐶".repeat(12));expect(widgets.at(-1)?.join(" ")).toContain("/away approve");
			expect(awaySuggestions("app",admin!.comparisonCode)?.map(item=>item.value)).toEqual([widgets.at(-1)![1].match(/\/away (approve [0-9a-f]+)/)![1]]);
			admin!.cancelEnrollment();expect(await comparison).toBe(false);expect(widgets.at(-1)).toBeUndefined();
			expect(awaySuggestions("app",admin!.comparisonCode)).toBeNull();
			expect(JSON.stringify([notices,widgets])).not.toContain("test-only-enrollment");
		} finally {await admin?.close()}
	} finally {await rm(dir,{recursive:true,force:true})}
});

test("recoverable mobile conditions and command guidance warn, while protocol failures remain errors",async()=>{
	const dir=await mkdtemp(join(tmpdir(),"away-notices-")), tokenFile=join(dir,"token");
	const notices:{text:string;type:string}[]=[];
	const ctx={ui:{notify:(text:string,type:string)=>notices.push({text,type}),setWidget(){}}} as unknown as ExtensionContext;
	let report!:(code:string)=>void, idle=false;
	try {
		await writeFile(tokenFile,Buffer.alloc(32,7).toString("base64url"),{mode:0o600});
		const admin=await openAdmin(ctx,()=>true,()=>idle,{
			env:{OMP_AWAY_URL:"https://example.invalid",OMP_AWAY_STATE_DIR:dir,OMP_AWAY_TOKEN_FILE:tokenFile},
			copy:async()=>{},
			async connect(_options,_preferences,onReport) {
				report=onReport;
				return {offer(){},end(){},configure(){},async close(){},async pair(){throw Error("Command must not start enrollment")}};
			},
		});
		try {
			notices.length=0;
			for (const code of ["phone_disconnected","relay_disconnected","unsupported-form","invite-unavailable","phone-control-unavailable"]) report(code);
			expect(notices.map(n=>n.type)).toEqual(["warning","warning","warning","warning","warning"]);
			report("phone_protocol_error"); report("secure_helper_protocol_error"); report("unexpected-failure");
			expect(notices.slice(-3).map(n=>n.type)).toEqual(["error","error","error"]);
			await admin!.command("pair");
			expect(notices.at(-1)?.type).toBe("warning");
			idle=true;
			await admin!.command("approve 0123456789ab");
			expect(notices.at(-1)?.type).toBe("warning");
			await admin!.command("fallback invalid");
			expect(notices.at(-1)?.type).toBe("warning");
		} finally {await admin?.close()}
	} finally {await rm(dir,{recursive:true,force:true})}
});

test("unset gateway keeps fixture local; partial, relative or missing credentials cannot start a transport",async()=>{
	const dir=await mkdtemp(join(tmpdir(),"away-config-"));
	let network=0;
	try {
		const config={OMP_AWAY_URL:"https://example.invalid",OMP_AWAY_STATE_DIR:dir,OMP_AWAY_TOKEN_FILE:join(dir,"missing.token")};
		expect(gatewayConfigured({})).toBe(false);
		for (const env of [{OMP_AWAY_URL:config.OMP_AWAY_URL},config,{...config,OMP_AWAY_TOKEN_FILE:"relative.token"},{...config,OMP_AWAY_STATE_DIR:"relative"},{...config,OMP_AWAY_TUNNEL_PYTHON:"relative-python"}]) {
			expect(gatewayConfigured(env)).toBe(true);
			await expect(openAdmin({} as ExtensionContext,()=>true,()=>true,{env,copy:async()=>{},connect:async()=>{network++;throw Error("unexpected transport")}})).rejects.toThrow();
		}
		expect(network).toBe(0);
	} finally {await rm(dir,{recursive:true,force:true})}
});
