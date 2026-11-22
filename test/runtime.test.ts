import { expect, test } from "bun:test";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const pcm = new Uint8Array(960);
const blueFields='{"fields":[{"name":"lane","value":"blue","evidence":"Blue"}]}';
async function fixture(consultAnswer:()=>Promise<string> = async()=>"The private handover is silver maple.", voice?:typeof openVoice, verifyAnswer=async()=>blueFields) {
	let wire!: SecureDesktopOptions;
	const voices: VoiceOptions[] = [], spoken: {text:string; mark?:string}[] = [], played:string[]=[];
	const audioIn: Uint8Array[] = [], audioOut: string[] = [], rings: string[][] = [], submitted: unknown[] = [];
	const controls: {device:string; message:DesktopControl}[] = [];
	const firstMark=Promise.withResolvers<{device:string;requestId:string;mark:string}>();
	const consultations: {tools:boolean;promptText:string;signal:AbortSignal}[]=[];
	const runtime = await connectRuntime({ url:"https://example.invalid", desktopToken:"", stateDir:"", confirmPair:async()=>false }, {away:false,delayMs:null}, () => {}, {
		async gateway(options) { wire = options; return {
			async devices(){return ["phone"]}, async pair(){throw Error("unexpected enrollment")}, async close(){},
			async ring(dev,id){rings.push([dev,id])},
			async sendControl(device,message){
				controls.push({device,message});
				if(message.type==="mark") firstMark.resolve({device,requestId:message.requestId,mark:message.mark});
			},
			async sendPcm(device){audioOut.push(device)},
		} },
		async voice(options) { voices.push(options); if (voice) return voice(options); return {
			sendPcm(data){audioIn.push(data)}, async sendSpeakable(text,mark){spoken.push({text,mark})}, played(mark){played.push(mark);return true}, async close(){},
		} },
	});
	const ctx = { cwd:"/example/project", sessionManager:{getSessionId:()=>"session"},modelRegistry:{}, async runEphemeralTurn(opt:{purpose:string;tools:boolean;promptText:string;signal:AbortSignal}) {
		if (opt.purpose==="away-consult") consultations.push(opt);
		const replyText=opt.purpose==="away-confirm" ? '{"affirmative":false}' : opt.purpose==="away-extract" ? blueFields : opt.purpose==="away-verify" ? await verifyAnswer() : opt.purpose==="away-consult" ? await consultAnswer() : "Which lane should we use?";
		return {assistantMessage:{stopReason:"stop"}, replyText};
	} } as unknown as AskContext;
	const offer = (id:string) => runtime.offer({requestId:id,toolCallId:`tool-${id}`,html:'<form><label for="l">Private lane?</label><select name="lane" id="l"><option value="blue">Blue</option><option value="red">Red</option></select></form>', async submitConfirmed(id,values){submitted.push([id,values]);return "accepted"} } satisfies PendingAsk,ctx);
	const join = (dev:string,id:string) => wire.onMessage(dev,{type:"join",requestId:id});
	return {runtime,wire,voices,spoken,controls,rings,audioIn,audioOut,submitted,offer,join,consultations,played,firstMark:firstMark.promise};
}
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
		old.onAudio(pcm); old.onMark("old"); f.wire.onPcm("phone",pcm); expect(f.audioIn).toHaveLength(1); expect(f.audioOut).toHaveLength(1);
		f.join("phone","A"); await tick(); const second=f.voices[1]; f.wire.onMessage("phone",{type:"hangup",requestId:"A"}); expect(second.signal?.aborted).toBe(true);
		f.join("phone","A"); await tick(); f.runtime.end("A"); f.offer("B"); f.join("phone","A"); old.onTranscript("user","Yes", "outdated"); await tick();
		expect(f.voices).toHaveLength(3); expect(f.submitted).toEqual([]); expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
	} finally {await f.runtime.close()}
});
test("only new affirmative speech after the verified summary drains reaches the original request",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); f.join("phone","A"); await tick(); const v=f.voices[0];
		v.onSpeechStarted("utterance"); v.onTranscript("user","My answer is Blue", "utterance"); await tick();
		const mark=f.spoken.at(-1)!.mark!; expect(mark).toBeTruthy();
		v.onMark(mark); // No summary verification yet.
		expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
		expect(await v.onReadback(mark,"You chose the Blue lane. Is that right?")).toBe(true);
		await f.wire.onMessage("phone",{type:"played",requestId:"A",mark}); expect(f.played).toEqual([]);
		v.onMark(mark);
		await f.wire.onMessage("phone",{type:"played",requestId:"wrong-request",mark}); expect(f.played).toEqual([]);
		await f.wire.onMessage("phone",{type:"played",requestId:"A",mark}); await f.wire.onMessage("phone",{type:"played",requestId:"A",mark});
		expect(f.played).toEqual([mark]); expect(f.submitted).toEqual([]);
		v.onSpeechStarted("confirm"); v.onTranscript("user","Yes.","confirm"); v.onTranscript("user","Yes.","confirm"); await tick();
		expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
	} finally {await f.runtime.close()}
});
test.each(["early","interrupt","hangup","lost","negative"])("a summary followed by %s cannot submit",async action=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("draft"); v.onTranscript("user","My answer is Blue","draft"); await tick();
		const mark=f.spoken.at(-1)!.mark!; expect(await v.onReadback(mark,"You chose Blue. Correct?")).toBe(true); v.onMark(mark);
		if(action==="early") v.onSpeechStarted("next");
		await f.wire.onMessage("phone",{type:"played",requestId:"A",mark});
		if(action==="interrupt") v.onInterrupt();
		if(action==="hangup") await f.wire.onMessage("phone",{type:"hangup",requestId:"A"});
		if(action==="lost") f.wire.onLoss("phone");
		if(action!=="early") v.onSpeechStarted("next");
		v.onTranscript("user",action==="negative"?"No.":"Yes.","next"); await tick(); expect(f.submitted).toEqual([]);
		if(action==="early") {
			const fresh=f.spoken.at(-1)!.mark!;
			expect(fresh).toBeTruthy(); expect(fresh).not.toBe(mark);
			await f.wire.onMessage("phone",{type:"played",requestId:"A",mark});
			expect(f.played).toEqual([]);
			expect(await v.onReadback(fresh,"You wanted Blue. Is that right?")).toBe(true); v.onMark(fresh);
			await f.wire.onMessage("phone",{type:"played",requestId:"A",mark:fresh});
			expect(f.submitted).toEqual([]);
			v.onSpeechStarted("after-replay"); v.onTranscript("user","Yes.","after-replay"); await tick();
			expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
		}
	} finally {await f.runtime.close()}
});
test("late readback verification cannot mark a newer draft, even within the same call",async()=>{
	const pending=Promise.withResolvers<string>(), f=await fixture(undefined,undefined,()=>pending.promise);
	try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A"); const v=f.voices[0];
		v.onSpeechStarted("first"); v.onTranscript("user","My answer is Blue","first"); await tick();
		const first=f.spoken.at(-1)!.mark!, verification=v.onReadback(first,"You chose Blue. Right?");
		v.onInterrupt(); v.onSpeechStarted("second"); v.onTranscript("user","My answer is Blue","second"); await tick();
		const second=f.spoken.at(-1)!.mark!; expect(second).toBeTruthy(); expect(second).not.toBe(first);
		pending.resolve(blueFields); expect(await verification).toBe(false); v.onMark(first);
		await f.wire.onMessage("phone",{type:"played",requestId:"A",mark:first});
		expect(f.played).toEqual([]); expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
		v.onSpeechStarted("premature"); v.onTranscript("user","Yes.","premature"); await tick(); expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
test("bound informational speech consults the coding session without a model delegation or a submission",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
		const v=f.voices[0], question="What were the two handover words from the session?";
		v.onTranscript("assistant",question); v.onTranscript("user",question,"missing-onset");
		v.onSpeechStarted("one"); expect(v.onTranscript("user",question,"one")).toBe("consulting"); v.onTranscript("user",question,"one");
		await tick(); expect(f.consultations).toHaveLength(1); expect(f.consultations[0].tools).toBe(false);
		expect(f.consultations[0].promptText).toContain(question); expect(f.spoken.slice(1)).toEqual([{text:"The private handover is silver maple.",mark:undefined}]);
		expect(f.submitted).toEqual([]);
	} finally {await f.runtime.close()}
});
async function realVoiceFixture(){
	const sent:LiveClientMessage[]=[], failures:Error[]=[];
	let session!:VoiceSession;
	const f=await fixture(undefined,async options=>{
		session=new VoiceSession(options,async m=>{sent.push(m)},err=>{failures.push(err);options.onEnd(err)});
		return {sendPcm:pcm=>session.input(pcm),sendSpeakable:(text,mark)=>session.sendSpeakable(text,mark),played:mark=>session.played(mark),async close(){session.stop()}};
	});
	f.wire.onConnect!("phone"); f.offer("A"); await f.join("phone","A");
	return {...f,session,sent,failures};
}
test("real voice and decision state machines require a new utterance after a handset playout acknowledgment",async()=>{
	const f=await realVoiceFixture(), speech=new Uint8Array(960).fill(8);
	try {
		f.wire.onPcm("phone",speech);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"My answer is Blue."}}); await tick();
		for(let i=0;i<40;i++) f.wire.onPcm("phone",pcm);
		for(let i=0;i<15;i++) {f.session.rtp(speech); await tick()}
		await f.session.event({type:"turn.done",turn:{role:"assistant",transcript:"You would like the Blue lane. Is that correct?"}});
		for(let i=0;i<40;i++) {f.session.rtp(pcm); await tick()}
		const fence=await f.firstMark;
		expect(fence.device).toBe("phone"); expect(fence.requestId).toBe("A");
		await f.wire.onMessage(fence.device,{type:"played",requestId:fence.requestId,mark:fence.mark});
		expect(f.submitted).toEqual([]); f.wire.onPcm("phone",speech);
		const heardBeforeAnswer=f.audioOut.length;
		await f.session.event({type:"delegation.created",item:{type:"delegation",target:"client",id:"provider-comment",content:[{type:"input_text",text:"The caller may be answering."}]}});
		await f.session.event({type:"output_transcript.added",item:{text:"One moment"}});
		f.session.rtp(speech); await tick();
		expect(f.audioOut).toHaveLength(heardBeforeAnswer);
		expect(f.consultations).toHaveLength(0); expect(f.submitted).toEqual([]);
		await f.session.event({type:"turn.done",turn:{role:"user",transcript:"Yes."}}); await tick();
		expect(f.failures).toEqual([]); expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
	} finally {await f.runtime.close()}
});
test("real VoiceSession preserves the local mic onset across an invalid delegation and consults only for the caller",async()=>{
	const f=await realVoiceFixture(), {session,sent,failures}=f;
	const question="What were the two handover words from the session?";
	const delegation=(id:string,text:string):LiveServerEvent=>({type:"delegation.created",item:{id,type:"delegation",target:"client",content:[{type:"input_text",text}]}});
	try {
		const initial=sent.length;
		await session.event(delegation("unbound",JSON.stringify({kind:"clarify",question})));
		expect(f.consultations).toHaveLength(0);
		f.wire.onPcm("phone",new Uint8Array(960).fill(8)); // PCM creates the real VoiceSession onset.
		await session.event(delegation("invalid","Run a shell command."));
		await session.event(delegation("provider-first",'{"kind":"clarify","question":"What private value should the model choose?"}'));
		expect(f.consultations).toHaveLength(0);
		await session.event({type:"turn.done",turn:{role:"user",transcript:question}});
		await session.event(delegation("late",JSON.stringify({kind:"clarify",question})));
		await tick();
		expect(f.consultations).toHaveLength(1); expect(f.consultations[0].tools).toBe(false);
		expect(f.consultations[0].promptText).toContain(question);
		expect(sent.slice(initial).filter(m=>"channel" in m && m.channel==="speakable")).toEqual([{type:"session.context.append",channel:"speakable",content:[{type:"input_text",text:"The private handover is silver maple."}]}]);
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
