import { expect, test, vi } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { connectAsyncQuestions, type AsyncQuestion, type QuestionSource } from "../src/runtime/async-ask";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { gatewayConfigured, openAdmin, type Admin } from "../src/runtime";
import type { PendingAsk } from "../src";
import type { DesktopControl, SecureDesktopOptions } from "../src/secure-channel";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import { VoiceSession } from "../src/media/session";
import type { openVoice, VoiceOptions } from "../src/media";
import { connectRuntime, type AskContext } from "../src/runtime/routing";
import { Enrollment } from "../src/runtime/enrollment";
import { awaySuggestions } from "../src/runtime/commands";
import { parseLiveServerEvent } from "../src/media/protocol";
import type { Preferences } from "../src/decisions";

const pcm = new Uint8Array(960);
const blueFields='{"fields":[{"name":"lane","value":"blue","evidence":"Blue"}]}';
interface RoutingBus { current:Preferences; clients:Set<SecureDesktopOptions> }
async function fixture(consultAnswer:()=>Promise<string> = async()=>"The private handover is silver maple.", voice?:typeof openVoice, stateDir="", shared?:RoutingBus) {
	let wire!: SecureDesktopOptions;
	const voices: VoiceOptions[] = [], spoken: {text:string;instruction:boolean}[] = [], sideCalls:string[]=[];
	const audioIn: Uint8Array[] = [], audioOut: string[] = [], rings: string[][] = [], submitted: unknown[] = [];
	const invalidations:string[][]=[];
	const controls: {device:string; message:DesktopControl}[] = [];
	const consultations: {tools:boolean;promptText:string;signal:AbortSignal}[]=[];
	const bus=shared ?? {current:{away:false,delayMs:null},clients:new Set<SecureDesktopOptions>()};
	const runtime = await connectRuntime({ url:"https://example.invalid", desktopToken:"", stateDir, confirmPair:async()=>false }, () => {}, {
		async gateway(options) { wire = options; bus.clients.add(options); options.onRouting?.(bus.current); return {
			async routing(patch={}) {
				bus.current={...bus.current,...patch};
				for(const client of bus.clients) client.onRouting?.(bus.current);
				return bus.current;
			},
			async devices(){return ["phone"]}, async pair(){throw Error("unexpected enrollment")}, async close(){bus.clients.delete(options)},
			async ring(dev,id){rings.push([dev,id])},
			async invalidate(dev,id){invalidations.push([dev,id])},
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
	return {runtime,wire,voices,spoken,controls,rings,invalidations,ctx,audioIn,audioOut,submitted,offer,join,consultations,sideCalls};
}
test("details are negotiated, request-scoped, and cleared across reconnects",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); f.offer("B");
		expect(f.controls.some(c=>c.message.type==="question")).toBe(false);
		f.controls.length=0;
		await f.wire.onMessage("phone",{type:"list",details:true});
		expect(f.controls.map(c=>c.message.type)).toEqual(["inbox","question","question"]);
		expect(f.controls[1].message).toMatchObject({type:"question",requestId:"A",display:{v:1,fields:[{label:"Private lane?",options:[{label:"Blue"},{label:"Red"}]}]}});
		f.wire.onConnect!("new-phone");
		await f.wire.onMessage("new-phone",{type:"list",details:true});
		expect(JSON.stringify(f.controls.filter(c=>c.device==="new-phone"))).not.toContain("Private lane");
		f.wire.onLoss("phone"); f.controls.length=0; f.wire.onConnect!("phone");
		expect(f.controls.map(c=>c.message.type)).toEqual(["inbox"]);
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("proposal metadata comes from a validated draft, never assistant speech or captions",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.wire.onMessage("phone",{type:"list",details:true});
		await f.join("phone","A"); const v=f.voices[0];
		v.onCaption?.("assistant","Invented option",true);
		expect(f.controls.some(c=>c.message.type==="proposal" && c.message.text!=="")).toBe(false);
		v.onSpeechStarted("draft"); v.onTranscript("user","Blue.","draft"); await tick();
		expect(f.controls.filter(c=>c.message.type==="proposal").at(-1)?.message).toEqual({type:"proposal",requestId:"A",text:"Private lane?: Blue"});
		v.onInterrupt();
		expect(f.controls.at(-1)?.message).toEqual({type:"proposal",requestId:"A",text:""});
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("rejecting a readback clears its visual proposal without submitting",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.wire.onMessage("phone",{type:"list",details:true});
		await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("draft"); v.onTranscript("user","Blue.","draft"); await tick();
		expect(f.controls.filter(c=>c.message.type==="proposal").at(-1)?.message).toMatchObject({text:"Private lane?: Blue"});
		v.onSpeechStarted("reject"); v.onTranscript("user","No.","reject"); await tick();
		expect(f.controls.filter(c=>c.message.type==="proposal").at(-1)?.message).toEqual({type:"proposal",requestId:"A",text:""});
		expect(f.submitted).toEqual([]);
		expect(v.signal?.aborted).toBe(false);
	} finally {await f.runtime.close()}
});
test("retirement wakes the birth audience even offline, only once, before shutdown",async()=>{
	const f=await fixture();
	f.offer("A"); f.wire.onConnect!("new-phone"); f.offer("B");
	f.runtime.end("A"); f.runtime.end("A");
	expect(f.invalidations).toEqual([["phone","A"]]);
	await f.runtime.close();
	expect(f.invalidations).toEqual([["phone","A"],["phone","B"],["new-phone","B"]]);
});
test("accepted desktop submission retires request references and wakes its audience",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
		const v=f.voices[0]; v.onSpeechStarted("draft"); v.onTranscript("user","Blue","draft"); await tick();
		v.onSpeechStarted("yes"); v.onTranscript("user","Yes","yes"); await tick();
		expect(f.invalidations).toEqual([["phone","A"]]);
		expect(f.controls.at(-1)?.message).toEqual({type:"inbox",items:[]});
		f.runtime.end("A"); expect(f.invalidations).toHaveLength(1);
	} finally {await f.runtime.close()}
});
test("async withdrawal and source loss use the same projection and retirement authority",async()=>{
	const f=await fixture(), events=new EventBus(), life=new AbortController();
	let publish!:(questions:readonly AsyncQuestion[])=>void;
	const question:AsyncQuestion={id:"canonical",requestId:"async-A",toolCallId:"async-tool",title:"Not the question",blockedWork:"Private work",createdAt:1,
		html:'<form><input type="hidden" name="token" value="secret-capability"><label>Where?<select name="target"><option value="native-secret">Here</option></select></label></form>',
		submitConfirmed(){return {kind:"accepted",answerId:"answer",delivery:"queued"}}};
	const source:QuestionSource={version:1,sessionId:"session",signal:life.signal,subscribe(next){publish=next;next([question]);return ()=>{}}};
	events.on("omp-async-ask:connect:v1",value=>{
		if(value && typeof value==="object" && "accept" in value && typeof value.accept==="function") value.accept(source);
	});
	const connection=connectAsyncQuestions(events,"session",f.runtime,f.ctx as ExtensionContext,()=>{});
	try {
		f.wire.onConnect!("phone"); await f.wire.onMessage("phone",{type:"list",details:true});
		expect(f.controls.find(c=>c.message.type==="inbox" && c.message.items.length)?.message).toMatchObject({items:[{question:"Where?"}]});
		const wire=JSON.stringify(f.controls);
		expect(wire).toContain('"label":"Here"'); expect(wire).not.toContain("secret-capability"); expect(wire).not.toContain("native-secret"); expect(wire).not.toContain("Not the question");
		publish([]); expect(f.invalidations).toEqual([["phone","async-A"]]);
		publish([{...question,id:"second",requestId:"async-B"}]); life.abort();
		expect(f.invalidations).toEqual([["phone","async-A"],["phone","async-B"]]);
	} finally {connection.close();await f.runtime.close()}
});
test("oversized inbox never sends a partial authoritative snapshot",async()=>{
	const f=await fixture(); try {
		for(let i=0;i<400;i++) f.offer(`request-${i}`,'<form><label>'+"Q".repeat(256)+'<input name="answer"></label></form>');
		f.wire.onConnect!("phone");
		expect(f.controls.some(c=>c.message.type==="inbox")).toBe(false);
		expect(f.controls.at(-1)?.message).toEqual({type:"error",code:"inbox-too-large"});
	} finally {await f.runtime.close()}
});
test("session names use real context while old or unsafe metadata keeps project fallback",async()=>{
	const f=await fixture(); try {
		f.ctx.sessionManager.getSessionName=()=>"Release review";
		f.offer("named"); f.ctx.sessionManager.getSessionName=()=>"/private/session/path";
		f.offer("unsafe"); f.ctx.sessionManager.getSessionName=()=>undefined;
		f.offer("unnamed"); f.wire.onConnect!("phone");
		expect(f.controls.at(-1)?.message).toMatchObject({type:"inbox",items:[
			{requestId:"named",session:"Release review",project:"project"},
			{requestId:"unsafe",project:"project"},{requestId:"unnamed",project:"project"},
		]});
		const wire=JSON.stringify(f.controls);
		expect(wire).not.toContain("/private/session/path"); expect(wire).not.toContain('"session":"session"');
	} finally {await f.runtime.close()}
});
test("an oversized voice readback keeps its complete visual display and rejects joining clearly",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone");
		f.offer("large",'<form><label>Choose<select name="x"><option value="a">'+"A".repeat(4500)+'</option><option value="b">'+"B".repeat(4500)+'</option></select></label></form>');
		await f.wire.onMessage("phone",{type:"list",details:true});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"question",requestId:"large"});
		await f.join("phone","large");
		expect(f.controls.at(-1)?.message).toEqual({type:"error",code:"voice-unavailable"});
		expect(f.voices).toHaveLength(0); expect(f.invalidations).toHaveLength(0);
	} finally {await f.runtime.close()}
});
test("shared routing updates pending asks once, new sessions inherit, and active calls keep their authority",async()=>{
	const bus:RoutingBus={current:{away:false,delayMs:null},clients:new Set()};
	const a=await fixture(undefined,undefined,"",bus), b=await fixture(undefined,undefined,"",bus);
	let c:typeof a|undefined;
	try {
		a.wire.onConnect!("phone"); b.wire.onConnect!("phone");
		a.offer("active"); await a.join("phone","active");
		a.offer("queued-a"); b.offer("queued-b");
		await a.runtime.configure({away:true});
		await b.runtime.configure({away:true});
		expect(a.rings).toEqual([["phone","queued-a"]]);
		expect(b.rings).toEqual([["phone","queued-b"]]);
		c=await fixture(undefined,undefined,"",bus); c.wire.onConnect!("phone"); c.offer("new-session");
		expect(c.rings).toEqual([["phone","new-session"]]);
		await b.runtime.configure({away:false});
		a.offer("after-off"); b.offer("after-off-b");
		expect(a.rings).toEqual([["phone","queued-a"]]);
		expect(b.rings).toEqual([["phone","queued-b"]]);
		const voice=a.voices[0];
		expect(voice.signal?.aborted).toBe(false);
		voice.onSpeechStarted("choice"); voice.onTranscript("user","Blue","choice"); await tick();
		voice.onSpeechStarted("yes"); voice.onTranscript("user","Yes","yes"); await tick();
		expect(a.submitted).toEqual([["active",{lane:"blue"}]]);
		expect(b.submitted).toEqual([]);
	} finally {await a.runtime.close();await b.runtime.close();await c?.runtime.close()}
});

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
		await f.runtime.configure({away:true,delayMs:null}); f.wire.onPcm("phone",pcm); f.join("unknown","request-A");
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
test("unbound or duplicate informational speech cannot start desktop work or submit",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
		const v=f.voices[0], question="What were the two handover words from the session?";
		v.onTranscript("assistant",question); v.onTranscript("user",question,"missing-onset");
		v.onSpeechStarted("one"); v.onTranscript("user",question,"one"); v.onTranscript("user",question,"one");
		await tick(); expect(f.consultations).toHaveLength(0);
		expect(f.spoken).toHaveLength(1);
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("ordinary task questions leave the realtime voice to answer without a second desktop-model reply",async()=>{
	const f=await fixture();
	try {
		f.wire.onConnect!("phone");f.offer("A");await f.join("phone","A");
		const voice=f.voices[0];
		voice.onSpeechStarted("context");
		voice.onTranscript("user","What were we working on?","context");
		voice.onTranscript("assistant","We are adding offline storage to the notes app.");
		await tick();
		expect(f.sideCalls).toEqual([]);
		expect(f.spoken).toHaveLength(1);
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("a talkative context request classified as discussion does not queue a duplicate spoken answer",async()=>{
	const f=await fixture();
	Object.assign(f.ctx,{async runEphemeralTurn(){return {assistantMessage:{stopReason:"stop"},replyText:'{"clarify":true}'}}});
	try {
		f.wire.onConnect!("phone");f.offer("A");await f.join("phone","A");
		const voice=f.voices[0];
		voice.onSpeechStarted("context");
		voice.onTranscript("user","I was making lunch and lost track. Remind me what this project is about.","context");
		await tick();
		expect(f.spoken).toHaveLength(1);
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test.each([
	"Ask the main model to come up with some other two drinks",
	"Could you please ask the main model for two other drinks?",
	"Please suggest two alternative drinks.",
])("direct informational conversation cannot approve the previous draft: %s",async request=>{
	const f=await fixture();
	try {
		f.wire.onConnect!("phone");
		f.offer("A",'<form><fieldset><legend>Which drink would you like?</legend><label><input type="radio" name="drink" value="tea">Tea</label><label><input type="radio" name="drink" value="coffee">Coffee</label></fieldset></form>');
		await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("proposal"); v.onTranscript("user","Coffee","proposal"); await tick();
		v.onSpeechStarted("request"); v.onTranscript("user",request,"request"); await tick();
		expect(f.spoken).toHaveLength(2); // Opening and the original validated readback only.
		expect(f.sideCalls).toEqual([]);
		v.onSpeechStarted("yes"); v.onTranscript("user","Yes","yes"); await tick();
		expect(f.submitted).toEqual([]);
		v.onSpeechStarted("fresh"); v.onTranscript("user","Coffee","fresh"); await tick();
		v.onSpeechStarted("confirm"); v.onTranscript("user","Yes","confirm"); await tick();
		expect(f.submitted).toEqual([["A",{drink:"coffee"}]]);
	} finally {await f.runtime.close()}
});
async function realVoiceFixture(stateDir="",html?:string){
	vi.useFakeTimers();let now=100;
	const clock=vi.spyOn(performance,"now").mockImplementation(()=>now);
	const sent:LiveClientMessage[]=[], failures:Error[]=[];
	let session!:VoiceSession;
	try {
		const f=await fixture(undefined,async options=>{
			session=new VoiceSession(options,async m=>{sent.push(m)},err=>{failures.push(err);options.onEnd(err)},undefined,options.log);
			return {sendPcm:pcm=>session.input(pcm),sendSpeakable:(text,instruction)=>session.sendSpeakable(text,instruction),async close(){session.stop()}};
		},stateDir);
		f.wire.onConnect!("phone"); f.offer("A",html); await f.join("phone","A");
		const close=f.runtime.close.bind(f.runtime);
		f.runtime.close=async()=>{try{await close()}finally{clock.mockRestore();vi.useRealTimers()}};
		const capture=(count:number,frame=pcm)=>{
			for(let i=0;i<count;i++){now+=20;f.wire.onPcm("phone",frame);vi.advanceTimersByTime(20)}
		};
		return {...f,session,sent,failures,capture,
			advance(ms:number){now+=ms;vi.advanceTimersByTime(ms)},
			async quiet(){
				capture(75);
				await tick();
			},
		};
	} catch(error){clock.mockRestore();vi.useRealTimers();throw error}
}
test.each([["Yes.","yes","Yes"],["No.","no","No"]])
("real voice proposes the literal %s option, then a fresh Yes submits canonical values",async(answer,value,label)=>{
	const html='<form><fieldset><legend>Continue?</legend><label><input type="radio" name="proceed" value="yes">Yes</label><label><input type="radio" name="proceed" value="no" checked>No</label></fieldset></form>';
	const f=await realVoiceFixture("",html), speech=new Uint8Array(960).fill(8);
	try {
		await f.wire.onMessage("phone",{type:"list",details:true});
		f.session.rtp(speech); await tick();
		const openingMessages=f.sent.length;
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:answer}}); await f.quiet();
		expect(f.submitted).toEqual([]);
		expect(f.controls.filter(c=>c.message.type==="proposal").at(-1)?.message).toEqual({type:"proposal",requestId:"A",text:`Continue?: ${label}`});
		const readback=f.sent.slice(openingMessages).map(message=>
			message.type==="session.context.append" && message.channel==="commentary"
				? message.content.map(part=>part.type==="input_text" ? part.text : "").join("") : "").join("");
		expect(readback).toContain(`"answer":"${label}"`);
		await f.session.event({type:"turn.done",turn:{role:"assistant",transcript:"Okay."}});
		expect(f.submitted).toEqual([]);
		for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);
		f.session.rtp(speech); await tick();
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Yes."}}); await f.quiet();
		expect(f.submitted).toEqual([["A",{proceed:value}]]);
		expect(f.invalidations).toEqual([["phone","A"]]);
		expect(f.controls.at(-1)?.message).toEqual({type:"inbox",items:[]});
		expect(f.failures).toEqual([]); expect(f.sideCalls).toEqual([]);
		expect(f.voices[0].signal?.aborted).toBe(true);
	} finally {await f.runtime.close()}
});
test("a provider-final Yes plus a continuing correction cannot submit the old native draft",async()=>{
	const f=await realVoiceFixture(),speech=new Uint8Array(960).fill(8);
	const event=async(text:string,start:number,end:number,final=false)=>{
		await f.session.event(parseLiveServerEvent(final
			? {type:"turn.done",turn:{role:"user",transcript:text,start_ms:start,end_ms:end}}
			: {type:"input_transcript.added",item:{text},start_ms:start,end_ms:end})!);
	};
	Object.assign(f.ctx,{async runEphemeralTurn(){return {assistantMessage:{stopReason:"stop"},
		replyText:'{"fields":[{"name":"lane","value":"red","evidence":"Red"}]}'}}});
	try {
		await f.wire.onMessage("phone",{type:"list",details:true});
		f.capture(3,speech);await event("Blue.",0,100);await event("Blue.",0,100,true);await f.quiet();
		f.capture(3,speech);await event("Yes.",200,300);await event("Yes.",200,300,true);
		f.capture(40);expect(f.submitted).toEqual([]);
		f.capture(3,speech);await event("But change it to Red.",400,600);await event("But change it to Red.",400,600,true);
		expect(f.submitted).toEqual([]);
		await f.quiet();
		expect(f.submitted).toEqual([]);
		expect(f.controls.filter(c=>c.message.type==="proposal").at(-1)?.message)
			.toEqual({type:"proposal",requestId:"A",text:"Private lane?: Red"});
		f.capture(3,speech);await event("Yes.",700,800);await event("Yes.",700,800,true);await f.quiet();
		expect(f.submitted).toEqual([["A",{lane:"red"}]]);
		expect(f.failures).toEqual([]);
	} finally {await f.runtime.close()}
});
test("the direct voice receives all native option labels and discussing them cannot approve a proposal",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
		const v=f.voices[0]; v.onSpeechStarted("proposal"); v.onTranscript("user","Blue.","proposal"); await tick();
		v.onSpeechStarted("q"); v.onTranscript("user","What are the options?","q"); await tick();
		expect(v.brief).toContain("Blue");expect(v.brief).toContain("Red");
		expect(f.spoken).toHaveLength(2);
		expect(f.sideCalls).toEqual([]);
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
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Blue."}}); await f.quiet();
		for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);
		f.session.rtp(speech); await tick();
		expect(f.submitted).toEqual([]); expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"unknown",wireType:"turn.interrupted"});
		await f.session.event({type:"turn.done",turn:{role:"assistant",transcript:"Okay, submitting."}});
		expect(f.submitted).toEqual([]);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Yeah..."}}); await f.quiet();
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
			expect(rows.filter(row=>row.phase==="resolved-silence").map(row=>row.text)).toEqual(["Blue.","Yeah..."]);
		} else if(mode==="unwritable") expect(files).toEqual([]);
		else {expect(failure).toHaveBeenCalled();expect(files).toHaveLength(1);expect(files[0]).toEndWith(".active.jsonl")}
	} finally {failure?.mockRestore();await f.runtime.close();await rm(root,{recursive:true,force:true})}
});
test("missing provider finals still require a new affirmative and submit the native draft exactly once",async()=>{
	const f=await realVoiceFixture();
	const speech=new Uint8Array(960).fill(8);
	const quiet=(count:number)=>f.capture(count);
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
	} finally {await f.runtime.close()}
});
test("real VoiceSession rejects work delegations without routing ordinary conversation through another model",async()=>{
	const f=await realVoiceFixture(), {session,sent,failures}=f;
	const question="What were the two handover words from the session?";
	const delegation=(id:string,text:string):LiveServerEvent=>({type:"delegation.created",item:{id,type:"delegation",target:"client",content:[{type:"input_text",text}]}});
	try {
		await f.wire.onMessage("phone",{type:"list",details:true});
		const initial=sent.length;
		await session.event(delegation("unbound",JSON.stringify({kind:"clarify",question})));
		expect(f.consultations).toHaveLength(0);
		const speech=new Uint8Array(960).fill(8);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech); // Sustained PCM creates the real VoiceSession onset.
		await session.event(delegation("invalid","Run a shell command."));
		await session.event(delegation("provider-first",'{"kind":"clarify","question":"What private value should the model choose?"}'));
		expect(f.consultations).toHaveLength(0);
		await session.event({type:"turn.done",turn:{role:"user",transcript:question}});
		await f.quiet();
		expect(f.controls.at(-1)?.message).toEqual({type:"proposal",requestId:"A",text:""});
		await session.event(delegation("late",JSON.stringify({kind:"clarify",question})));
		await tick();
		expect(f.consultations).toHaveLength(0);
		expect(f.sideCalls).toEqual([]);
		const spoken=sent.slice(initial).filter(m=>m.type==="session.context.append" && m.channel==="speakable");
		expect(spoken).toHaveLength(0);
		expect(failures).toEqual([]); expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("microphone noise without recognized speech cannot cancel pending proposal interpretation",async()=>{
	const pending=Promise.withResolvers<string>(), f=await realVoiceFixture();
	const speech=new Uint8Array(960).fill(8);
	let signal:AbortSignal|undefined;
	Object.assign(f.ctx,{async runEphemeralTurn(options:{signal:AbortSignal}){
		signal=options.signal;return {assistantMessage:{stopReason:"stop"},replyText:await pending.promise};
	}});
	try {
		await f.wire.onMessage("phone",{type:"list",details:true});
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Choose Blue."}});
		await f.quiet();expect(signal).toBeDefined();
		for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		expect(signal!.aborted).toBe(false);
		pending.resolve(blueFields);await tick();
		expect(f.controls.filter(c=>c.message.type==="proposal").at(-1)?.message)
			.toEqual({type:"proposal",requestId:"A",text:"Private lane?: Blue"});
		expect(f.submitted).toEqual([]);
		expect(f.failures).toEqual([]);
	} finally {pending.resolve(blueFields);await f.runtime.close()}
});
test("late recognition of an early affirmative cannot approve a draft created after its microphone onset",async()=>{
	const pending=Promise.withResolvers<string>(), f=await realVoiceFixture();
	const speech=new Uint8Array(960).fill(8);
	Object.assign(f.ctx,{async runEphemeralTurn(){return {assistantMessage:{stopReason:"stop"},replyText:await pending.promise}}});
	const onset=()=>{for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);for(let i=0;i<3;i++) f.wire.onPcm("phone",speech)};
	try {
		await f.wire.onMessage("phone",{type:"list",details:true});
		onset();
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Choose Blue."}});
		await f.quiet();
		f.advance(100);onset();
		f.advance(100);pending.resolve(blueFields);await tick();
		expect(f.controls.filter(c=>c.message.type==="proposal").at(-1)?.message)
			.toEqual({type:"proposal",requestId:"A",text:"Private lane?: Blue"});
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Yes."}});await f.quiet();
		expect(f.submitted).toEqual([]);
		f.advance(100);onset();
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Repeat that."}});await f.quiet();
		f.advance(100);onset();
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Yes."}});await f.quiet();
		expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
		expect(f.failures).toEqual([]);
	} finally {pending.resolve(blueFields);await f.runtime.close()}
});
test("unscoped confirmation after pre-draft echo keeps the conservative onset guard",async()=>{
	const pending=Promise.withResolvers<string>(), f=await realVoiceFixture();
	const speech=new Uint8Array(960).fill(8), echo=new Uint8Array(960).fill(4);
	Object.assign(f.ctx,{async runEphemeralTurn(){return {assistantMessage:{stopReason:"stop"},replyText:await pending.promise}}});
	try {
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Choose Blue."}});await f.quiet();
		for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);
		f.advance(100);f.session.rtp(speech);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",echo);
		f.advance(100);pending.resolve(blueFields);await tick();
		f.advance(700);
		for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);
		for(let i=0;i<3;i++) f.wire.onPcm("phone",speech);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Yes, please go ahead."}});await f.quiet();
		expect(f.submitted).toEqual([]);
		expect(f.failures).toEqual([]);
	} finally {pending.resolve(blueFields);await f.runtime.close()}
});
test.each(["fresh","early","earlier-final","unscoped-final","earlier-partial","unacknowledged","unrelated-answer","no-fresh-capture","duplicate-ack","missing-range"])
("readback onset binding remains fail-closed: %s",async scenario=>{
	const pending=Promise.withResolvers<string>(), f=await realVoiceFixture();
	const speech=new Uint8Array(960).fill(8);
	Object.assign(f.ctx,{async runEphemeralTurn(){return {assistantMessage:{stopReason:"stop"},replyText:await pending.promise}}});
	const onset=()=>{for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);for(let i=0;i<3;i++) f.wire.onPcm("phone",speech)};
	const event=async(payload:unknown)=>{const parsed=parseLiveServerEvent(payload);expect(parsed).not.toBeNull();await f.session.event(parsed!)};
	let acknowledged=0,through=0;
	const acknowledge=async()=>{
		for(;acknowledged<f.sent.length;acknowledged++) if(f.sent[acknowledged].type==="session.context.append") {
			const start=through;through+=100;
			await event({type:"session.context.appended",start_ms:start,end_ms:through});
		}
	};
	try {
		// Account for the opening before the current draft is issued.
		await acknowledge();
		onset();
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Choose Blue."}});await f.quiet();
		f.advance(100);onset(); // Loud echo, or an actual premature affirmative.
		f.advance(100);pending.resolve(blueFields);await tick();
		if(scenario!=="unacknowledged") await acknowledge();
		if(scenario==="duplicate-ack")
			await event({type:"session.context.appended",start_ms:through-100,end_ms:through});
		f.advance(500);
		await event({type:"turn.done",turn:{role:"assistant",
			transcript:scenario==="unrelated-answer"?"Let me check.":"Blue. Submit?",
			...(scenario==="missing-range"?{}:{start_ms:400,end_ms:800})}});
		expect(f.submitted).toEqual([]);
		f.advance(200);
		if(scenario!=="no-fresh-capture") onset(); // A real new confirmation, or subsequent unrelated noise.
		// Recognition can lag capture past context acknowledgement. Only the
		// fresh case follows the complete readback in the provider's timeline.
		const start=scenario==="early"?500:1000,end=scenario==="early"?700:1200;
		await event({type:"input_transcript.added",item:{text:"Yes."},start_ms:start,end_ms:end});
		if(scenario==="earlier-partial")await event({type:"input_transcript.added",item:{text:"Yes."},start_ms:500,end_ms:end});
		await event({type:"turn.done",turn:{role:"user",transcript:"Yes.",
			...(scenario==="unscoped-final"?{}:{start_ms:scenario==="earlier-final"?500:start,end_ms:end})}});
		if(!f.failures.length)await f.quiet();
		expect(f.submitted).toEqual(scenario==="fresh"?[["A",{lane:"blue"}]]:[]);
		if(["earlier-final","unscoped-final","earlier-partial"].includes(scenario))expect(f.failures).toHaveLength(1);
		else expect(f.failures).toEqual([]);
	} finally {pending.resolve(blueFields);await f.runtime.close()}
});
test.each(["Run the release now.", "Can you deploy the blue lane?", "Please change the chosen lane.", "What is the lane? Then deploy it.", "Yes submit this.", "I am not sure."])("non-clarification does not consult: %s",async text=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("one"); v.onTranscript("user",text,"one"); await tick();
		expect(f.consultations).toHaveLength(0); expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test.each(["interrupt","hangup","end"])("late proposal interpretation cannot speak after %s",async stop=>{
	const pending=Promise.withResolvers<string>(), f=await fixture();
	let signal:AbortSignal|undefined;
	Object.assign(f.ctx,{async runEphemeralTurn(options:{signal:AbortSignal}){
		signal=options.signal;return {assistantMessage:{stopReason:"stop"},replyText:await pending.promise};
	}});
	try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("u"); v.onTranscript("user","Choose Blue.","u"); await tick();
		expect(signal).toBeDefined();
		if (stop==="interrupt") v.onInterrupt(); else if (stop==="end") f.runtime.end("A"); else f.wire.onMessage("phone",{type:"hangup",requestId:"A"});
		expect(signal!.aborted).toBe(true);pending.resolve(blueFields);await tick();
		expect(f.spoken).toHaveLength(1); expect(f.submitted).toEqual([]);
	} finally {pending.resolve(blueFields);await f.runtime.close()}
});
test("comparison is local, one-use, and cannot authorize a new enrollment with an old command",async()=>{
	let status:string|undefined; const confirmation=new Enrollment(text=>{status=text});
	const first=confirmation.compare("🐶".repeat(12)); const code=status!.match(/\/away approve ([0-9a-f]+)/)![1];
	expect(confirmation.decide(false,code)).toBe(true); expect(await first).toBe(false);
	const second=confirmation.compare("🐱".repeat(12)); expect(confirmation.decide(true,code)).toBe(false);
	const fresh=status!.match(/\/away approve ([0-9a-f]+)/)![1]; expect(confirmation.decide(true,fresh)).toBe(true); expect(await second).toBe(true); expect(status).toBeUndefined();
});

test("shared routing commands are idempotent patches and status follows remote updates",async()=>{
	const dir=await mkdtemp(join(tmpdir(),"away-shared-admin-")), tokenFile=join(dir,"token");
	const notices:string[][]=[[],[]], subscribers:((next:Preferences)=>void)[]=[];
	let current:Preferences={away:false,delayMs:null};
	const gate=Promise.withResolvers<void>();
	let delayed=false;
	const env={OMP_AWAY_URL:"https://example.invalid",OMP_AWAY_STATE_DIR:dir,OMP_AWAY_TOKEN_FILE:tokenFile};
	const admins:Admin[]=[];
	try {
		await writeFile(tokenFile,Buffer.alloc(32,7).toString("base64url"),{mode:0o600});
		for(let i=0;i<2;i++) {
			const ctx={ui:{notify:(text:string)=>notices[i].push(text),setWidget(){}}} as unknown as ExtensionContext;
			admins.push((await openAdmin(ctx,()=>true,()=>true,{env,copy:async()=>{},async connect(options){
				if(options.onRouting) {subscribers.push(options.onRouting);options.onRouting(current)}
				return {offer(){},end(){},async close(){},async pair(){throw Error("not pairing")},
					async configure(patch) {
						current={...current,...patch};
						for(const subscriber of subscribers) subscriber(current);
						if(delayed) await gate.promise;
					},
				};
			}}))!);
		}
		await admins[0].command(""); await admins[0].command("");
		expect(current.away).toBe(true);
		await admins[1].command("fallback 30");
		expect(current).toEqual({away:true,delayMs:30000});
		await admins[0].command("status");
		expect(notices[0].at(-1)).toMatch(/immediate: on.*fallback: 30s/);
		delayed=true;
		const pending=admins[0].command("on"); await tick();
		current={...current,away:false}; for(const subscriber of subscribers) subscriber(current);
		gate.resolve(); await pending;
		await admins[0].command("status");
		expect(notices[0].at(-1)).toMatch(/immediate: off.*fallback: 30s/);
		expect(await Bun.file(join(dir,"routing.json")).exists()).toBe(false);
	} finally {gate.resolve();for(const admin of admins)await admin.close();await rm(dir,{recursive:true,force:true})}
});

test("admin uses only the private clipboard for enrollment; busy Ask blocks comparison, not the native form",async()=>{
	const dir=await mkdtemp(join(tmpdir(),"away-admin-")), tokenFile=join(dir,"token");
	const notices:string[]=[], widgets:(string[]|undefined)[]=[], copied:string[]=[];
	const ctx={ui:{notify:(text:string)=>notices.push(text),setWidget:(_key:string,lines:string[]|undefined)=>widgets.push(lines)}} as unknown as ExtensionContext;
	const env={OMP_AWAY_URL:"https://example.invalid",OMP_AWAY_STATE_DIR:dir,OMP_AWAY_TOKEN_FILE:tokenFile};
	let confirm!:SecureDesktopOptions["confirmPair"], pairs=0, idle=true;
	try {
		await writeFile(tokenFile,Buffer.alloc(32,7).toString("base64url"),{mode:0o600});
		const admin=await openAdmin(ctx,()=>true,()=>idle,{env,copy:async payload=>{copied.push(payload)},async connect(options){
			confirm=options.confirmPair;
			return {offer(){},end(){},async close(){},async configure(){},async pair(){pairs++;return '{"secret":"test-only-enrollment"}'}};
		}});
		try {
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
			async connect(_options,onReport) {
				report=onReport;
				return {offer(){},end(){},async configure(){},async close(){},async pair(){throw Error("Command must not start enrollment")}};
			},
		});
		try {
			notices.length=0;
			for (const code of ["phone_disconnected","relay_disconnected","unsupported-form","invite-unavailable","phone-control-unavailable"]) report(code);
			expect(notices.map(n=>n.type)).toEqual(["warning","warning","warning","warning","warning"]);
			report("phone_protocol_error"); report("secure_helper_protocol_error"); report("unexpected-failure");
			expect(notices.slice(-3).map(n=>n.type)).toEqual(["error","error","error"]);
			expect(notices.every(n=>!n.text.includes("The desktop form stays available"))).toBe(true);
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
