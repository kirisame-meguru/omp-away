import { expect, test } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { connectAsyncQuestions, type AsyncQuestion, type QuestionSource } from "../src/runtime/async-ask";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ExtensionLiveStartOptions } from "@oh-my-pi/pi-coding-agent";
import { gatewayConfigured, openAdmin, type Admin } from "../src/runtime";
import type { AnswerNote, PendingAsk, Values } from "../src";
import type { DesktopControl, SecureDesktopOptions } from "../src/secure-channel";
import { openVoice, type VoiceOptions } from "../src/media";
import { connectRuntime, type AskContext } from "../src/runtime/routing";
import { Enrollment } from "../src/runtime/enrollment";
import { awaySuggestions } from "../src/runtime/commands";
import type { Preferences } from "../src/decisions";

const pcm=new Uint8Array(960);
interface RoutingBus {current:Preferences;clients:Set<SecureDesktopOptions>}
async function fixture(voice?:typeof openVoice,shared?:RoutingBus) {
	let wire!:SecureDesktopOptions;
	const voices:VoiceOptions[]=[],native:ExtensionLiveStartOptions[]=[],contexts:string[]=[],order:string[]=[];
	const audioIn:Uint8Array[]=[],audioOut:string[]=[],rings:string[][]=[],invalidations:string[][]=[];
	const submitted:[string,Values][]=[],notes:AnswerNote[][]=[],controls:{device:string;message:DesktopControl}[]=[];
	const media:{audio(pcm:Uint8Array):void;fail():void}[]=[];
	let closedPeers=0,closedLive=0;
	const bus=shared??{current:{away:false,delayMs:null},clients:new Set<SecureDesktopOptions>()};
	const ctx:AskContext={
		cwd:"/example/project",sessionManager:{getSessionId:()=>"session",getSessionName:()=>undefined},
		async awayContext(content){order.push("context");contexts.push(content)},
		async startLive(options){
			order.push("live");native.push(options);
			return {sdpAnswer:"answer",voice:"test",async stop(){++closedLive;options.onEnd?.()}};
		},
	};
	const runtime=await connectRuntime({url:"https://example.invalid",desktopToken:"",stateDir:"",confirmPair:async()=>false},()=>{},{
		async gateway(options){wire=options;bus.clients.add(options);options.onRouting?.(bus.current);return {
			async routing(patch={}){bus.current={...bus.current,...patch};for(const client of bus.clients)client.onRouting?.(bus.current);return bus.current},
			async devices(){return ["phone"]},async pair(){throw Error("unexpected enrollment")},async close(){bus.clients.delete(options)},
			async ring(device,id){rings.push([device,id])},async invalidate(device,id){invalidations.push([device,id])},
			async sendControl(device,message){controls.push({device,message})},async sendPcm(device){audioOut.push(device)},
		}},
		async voice(options){
			voices.push(options);
			if(voice) return voice(options);
			return openVoice(options,(audio,fail)=>{
				media.push({audio,fail});order.push("peer");
				return {offer:Promise.resolve("offer"),async answer(sdp){expect(sdp).toBe("answer");order.push("answer")},
					sendPcm(data){audioIn.push(data)},async close(){++closedPeers}};
			});
		},
	});
	const offer=(id:string,html='<form><label for="l">Private lane?</label><select name="lane" id="l"><option value="blue">Blue</option><option value="red">Red</option></select></label></form>',patch:Partial<PendingAsk>={})=>
		runtime.offer({requestId:id,toolCallId:`tool-${id}`,html,supportsOptionNotes:true,
			async submitConfirmed(id,values,optionNotes=[]){submitted.push([id,values]);notes.push(optionNotes);return "accepted"},...patch},ctx);
	const join=(device:string,id:string)=>wire.onMessage(device,{type:"join",requestId:id});
	return {runtime,wire,voices,native,contexts,order,media,controls,rings,invalidations,ctx,audioIn,audioOut,submitted,notes,offer,join,
		get closedPeers(){return closedPeers},get closedLive(){return closedLive}};
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
test("native captions and legacy playback controls cannot fabricate form proposals or submit",async()=>{
	const f=await fixture();try {
		f.wire.onConnect!("phone");f.offer("A");await f.wire.onMessage("phone",{type:"list",details:true});
		await f.wire.onMessage("phone",{type:"join",requestId:"A",captions:true});
		f.native[0].onTranscript?.({role:"assistant",text:"Blue. Submit?",turn:1,final:true});
		f.native[0].onTranscript?.({role:"user",text:"Yes.",turn:1,final:true});
		await f.wire.onMessage("phone",{type:"played",requestId:"A",mark:"old-proof"});
		expect(f.controls.some(c=>c.message.type==="proposal")).toBe(false);
		expect(f.controls.filter(c=>c.message.type==="transcript")).toHaveLength(2);
		expect(f.submitted).toEqual([]);
		expect(f.voices[0].call.signal.aborted).toBe(false);
	}finally{await f.runtime.close()}
});
test("retirement wakes the birth audience even offline, only once, before shutdown",async()=>{
	const f=await fixture();
	f.offer("A"); f.wire.onConnect!("new-phone"); f.offer("B");
	f.runtime.end("A"); f.runtime.end("A");
	expect(f.invalidations).toEqual([["phone","A"]]);
	await f.runtime.close();
	expect(f.invalidations).toEqual([["phone","A"],["phone","B"],["new-phone","B"]]);
});
test("accepted touch submission retires request references and wakes its audience",async()=>{
	const f=await fixture();try {
		f.wire.onConnect!("phone");f.offer("A");
		await f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue"}});
		expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
		expect(f.invalidations).toEqual([["phone","A"]]);
		expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",requestId:"A",status:"accepted"});
		expect(f.controls.some(c=>c.message.type==="inbox"&&!c.message.items.length)).toBe(true);
		f.runtime.end("A");expect(f.invalidations).toHaveLength(1);
	}finally{await f.runtime.close()}
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
	const connection=connectAsyncQuestions(events,"session",f.runtime,f.ctx,()=>{});
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
test("native live receives oversized legacy readbacks intact and owns its context limits",async()=>{
	const f=await fixture(); try {
		f.wire.onConnect!("phone");
		f.offer("large",'<form><label>Choose<select name="x"><option value="a">'+"A".repeat(4500)+'</option><option value="b">'+"B".repeat(4500)+'</option></select></label></form>');
		await f.wire.onMessage("phone",{type:"list",details:true});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"question",requestId:"large"});
		await f.join("phone","large");
		expect(f.controls.at(-1)?.message).toEqual({type:"joined",requestId:"large"});
		expect(f.voices).toHaveLength(1);expect(f.invalidations).toHaveLength(0);
		expect(f.contexts[0]).toContain("A".repeat(4500));expect(f.contexts[0]).toContain("B".repeat(4500));
	} finally {await f.runtime.close()}
});
test("shared routing updates pending asks once, new sessions inherit, and active calls keep their authority",async()=>{
	const bus:RoutingBus={current:{away:false,delayMs:null},clients:new Set()};
	const a=await fixture(undefined,bus),b=await fixture(undefined,bus);
	let c:typeof a|undefined;
	try {
		a.wire.onConnect!("phone"); b.wire.onConnect!("phone");
		a.offer("active"); await a.join("phone","active");
		a.offer("queued-a"); b.offer("queued-b");
		await a.runtime.configure({away:true});
		await b.runtime.configure({away:true});
		expect(a.rings).toEqual([["phone","queued-a"]]);
		expect(b.rings).toEqual([["phone","queued-b"]]);
		c=await fixture(undefined,bus);c.wire.onConnect!("phone");c.offer("new-session");
		expect(c.rings).toEqual([["phone","new-session"]]);
		await b.runtime.configure({away:false});
		a.offer("after-off"); b.offer("after-off-b");
		expect(a.rings).toEqual([["phone","queued-a"]]);
		expect(b.rings).toEqual([["phone","queued-b"]]);
		const voice=a.voices[0];
		expect(voice.call.signal.aborted).toBe(false);
		a.native[0].onTranscript?.({role:"user",text:"Yes",turn:1,final:true});
		expect(a.submitted).toEqual([]);
		await a.wire.onMessage("phone",{type:"hangup",requestId:"active"});
		await a.wire.onMessage("phone",{type:"answer",requestId:"active",values:{lane:"blue"}});
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
		f.wire.onLoss("phone");expect(old.call.signal.aborted).toBe(true);f.wire.onConnect!("phone");f.wire.onMessage("phone",{type:"list"});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"inbox",items:[{requestId:"A"}]});
		old.onAudio(pcm); f.wire.onPcm("phone",pcm); expect(f.audioIn).toHaveLength(1); expect(f.audioOut).toHaveLength(1);
		await f.join("phone","A");const second=f.voices[1];f.wire.onMessage("phone",{type:"hangup",requestId:"A"});expect(second.call.signal.aborted).toBe(true);
		await f.join("phone","A");f.runtime.end("A");f.offer("B");await f.join("phone","A");old.onCaption?.("user","Yes",true);await tick();
		expect(f.voices).toHaveLength(3); expect(f.submitted).toEqual([]); expect(f.controls.some(c=>c.message.type==="mark")).toBe(false);
	} finally {await f.runtime.close()}
});
test("native context is acknowledged after takeover and before live signaling or peer answer",async()=>{
	const f=await fixture();const release=Promise.withResolvers<void>();
	try {
		f.wire.onConnect!("phone");
		f.offer("A",undefined,{async takeOver(){f.order.push("takeover");await release.promise;return "accepted"}});
		const opening=f.join("phone","A");await tick();
		expect(f.order).toEqual(["peer","takeover"]);expect(f.native).toEqual([]);
		release.resolve();await opening;
		expect(f.order).toEqual(["peer","takeover","context","live","answer"]);
		expect(f.contexts[0]).toContain("Private lane?");
		expect(f.contexts[0]).toContain("Blue");expect(f.contexts[0]).toContain("Red");
		expect(f.submitted).toEqual([]);
	}finally{release.resolve();await f.runtime.close()}
});

test.each(["hangup","lost","end","close"])("pending native setup cannot resurrect after %s",async action=>{
	const f=await fixture(),release=Promise.withResolvers<void>();
	try {
		f.wire.onConnect!("phone");f.offer("A");
		f.ctx.awayContext=async content=>{f.contexts.push(content);await release.promise};
		const opening=f.join("phone","A");await tick();
		if(action==="hangup")await f.wire.onMessage("phone",{type:"hangup",requestId:"A"});
		if(action==="lost")f.wire.onLoss("phone");
		if(action==="end")f.runtime.end("A");
		if(action==="close")await f.runtime.close();
		release.resolve();await opening;await tick();
		expect(f.native).toEqual([]);expect(f.controls.some(c=>c.message.type==="joined")).toBe(false);
		expect(f.closedPeers).toBe(1);expect(f.submitted).toEqual([]);
	}finally{release.resolve();await f.runtime.close()}
});

test("native takeover retains its route through source retirement until the live session ends",async()=>{
	const f=await fixture();try {
		f.wire.onConnect!("phone");
		f.offer("A",undefined,{async takeOver(){f.runtime.end("A");return "accepted"}});
		await f.join("phone","A");
		expect(f.voices[0].call.signal.aborted).toBe(false);expect(f.invalidations).toEqual([]);
		f.wire.onPcm("phone",pcm);expect(f.audioIn).toHaveLength(1);
		f.native[0].onEnd?.();await tick();
		expect(f.voices[0].call.signal.aborted).toBe(true);expect(f.invalidations).toEqual([["phone","A"]]);
		expect(f.closedPeers).toBe(1);expect(f.closedLive).toBe(1);
	}finally{await f.runtime.close()}
});

test("native withdrawal forwards the discussion once and retires the source",async()=>{
	const f=await fixture();const withdrawals:string[]=[];
	try {
		f.wire.onConnect!("phone");
		f.offer("A",undefined,{async withdraw(_id,reason){withdrawals.push(reason);return "accepted"}});
		await f.join("phone","A");const call=f.voices[0].call;
		expect(await call.withdraw("Discussed another approach")).toBe("accepted");
		expect(await call.withdraw("Duplicate")).toBe("stale");
		expect(withdrawals).toEqual(["Discussed another approach"]);
		expect(call.signal.aborted).toBe(true);expect(f.invalidations).toEqual([["phone","A"]]);
		expect(f.submitted).toEqual([]);
	}finally{await f.runtime.close()}
});

test("one native voice owner blocks concurrent joins and touch until hangup",async()=>{
	const f=await fixture();try {
		f.wire.onConnect!("phone");f.wire.onConnect!("second");f.offer("A");f.offer("B");
		await f.join("phone","A");await f.join("second","B");
		await f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue"}});
		expect(f.voices).toHaveLength(1);expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"busy"});
		await f.wire.onMessage("phone",{type:"hangup",requestId:"A"});
		await f.wire.onMessage("second",{type:"answer",requestId:"A",values:{lane:"blue"}});
		expect(f.submitted).toEqual([["A",{lane:"blue"}]]);
	}finally{await f.runtime.close()}
});

test("touch forms hide desktop fields and canonicalize selected option notes",async()=>{
	const f=await fixture();try {
		f.wire.onConnect!("phone");
		f.offer("A",'<form><input type="hidden" name="revision" value="private"><label>Lane<select name="lane"><option value="blue">Blue label</option><option value="disabled" disabled>Unavailable</option></select></label><label>Count<input type="number" name="count" min="1" max="3" required></label></form>');
		await f.wire.onMessage("phone",{type:"form",requestId:"A"});const form=f.controls.at(-1)?.message;
		expect(form).toMatchObject({type:"form",form:{optionNotes:true,voice:true}});
		expect(JSON.stringify(form)).not.toContain("private");expect(JSON.stringify(form)).not.toContain("revision");
		await f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue",count:"2"},notes:[{name:"lane",value:"blue",text:"Prefer this lane"}]});
		expect(f.submitted).toEqual([["A",{revision:"private",lane:"blue",count:2}]]);
		expect(f.notes).toEqual([[{name:"lane",question:"Lane",option:"Blue label",value:"blue",text:"Prefer this lane"}]]);
	}finally{await f.runtime.close()}
});

test.each([{lane:"disabled"},{lane:"unknown"},{lane:true},{lane:"blue",hidden:"tampered"}])("invalid touch input never dispatches: %j",async values=>{
	const f=await fixture();try {
		f.wire.onConnect!("phone");f.offer("A");
		await f.wire.onMessage("phone",{type:"answer",requestId:"A",values});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"invalid"});expect(f.submitted).toEqual([]);
		await f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue"}});expect(f.submitted).toHaveLength(1);
	}finally{await f.runtime.close()}
});

test("unowned form and answer requests cannot reveal or dispatch a capability",async()=>{
	const f=await fixture();try {
		f.offer("A");f.wire.onConnect!("later");
		await f.wire.onMessage("later",{type:"form",requestId:"A"});
		expect(f.controls.at(-1)?.message).toEqual({type:"form",requestId:"A",form:null});
		await f.wire.onMessage("later",{type:"answer",requestId:"A",values:{lane:"blue"}});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"stale"});expect(f.submitted).toEqual([]);
	}finally{await f.runtime.close()}
});

test("concurrent touch attempts dispatch once and retain acceptance after synchronous retirement",async()=>{
	const f=await fixture(),receipt=Promise.withResolvers<"accepted">();let attempts=0;
	try {
		f.wire.onConnect!("phone");f.wire.onConnect!("second");
		f.offer("A",undefined,{async submitConfirmed(){++attempts;f.runtime.end("A");return receipt.promise}});
		const first=f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue"}});
		await f.wire.onMessage("second",{type:"answer",requestId:"A",values:{lane:"red"}});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"stale"});
		receipt.resolve("accepted");await first;
		expect(attempts).toBe(1);expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"accepted"});
	}finally{receipt.resolve("accepted");await f.runtime.close()}
});

test.each(["lost","reconnected","closed"])("delayed touch receipt cannot cross a %s connection boundary",async mode=>{
	const f=await fixture(),receipt=Promise.withResolvers<"accepted">();let attempts=0;
	try {
		f.wire.onConnect!("phone");
		f.offer("A",undefined,{async submitConfirmed(){++attempts;return receipt.promise}});
		const first=f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue"}});
		if(mode==="closed")await f.runtime.close();else f.wire.onLoss("phone");
		if(mode==="reconnected") {
			f.wire.onConnect!("phone");await f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"red"}});
			expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"stale"});
		}
		receipt.resolve("accepted");await first;expect(attempts).toBe(1);
		expect(f.controls.some(c=>c.message.type==="answer"&&c.message.status==="accepted")).toBe(false);
	}finally{receipt.resolve("accepted");await f.runtime.close()}
});

test.each(["stale","throw"])("uncertain touch outcome %s cannot be retried automatically",async outcome=>{
	const f=await fixture();let attempts=0;
	try {
		f.wire.onConnect!("phone");
		f.offer("A",undefined,{async submitConfirmed(){++attempts;if(outcome==="throw")throw Error("Uncertain");return "stale"}});
		await f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue"}});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"uncertain"});
		await f.wire.onMessage("phone",{type:"answer",requestId:"A",values:{lane:"blue"}});
		expect(f.controls.at(-1)?.message).toMatchObject({type:"answer",status:"stale"});
		await f.join("phone","A");expect(f.voices).toEqual([]);expect(attempts).toBe(1);
	}finally{await f.runtime.close()}
});

test("native mute, stale callbacks and media failure preserve the active call boundary",async()=>{
	const f=await fixture();try {
		f.wire.onConnect!("phone");f.offer("A");await f.join("phone","A");
		f.native[0].onPhase?.("muted");f.wire.onPcm("phone",pcm);expect(f.audioIn).toEqual([]);
		f.native[0].onPhase?.("listening");f.wire.onPcm("phone",pcm);expect(f.audioIn).toHaveLength(1);
		f.media[0].fail();await tick();expect(f.voices[0].call.signal.aborted).toBe(true);
		f.media[0].audio(pcm);f.native[0].onTranscript?.({role:"user",text:"Yes",turn:2,final:true});await tick();
		expect(f.audioOut).toEqual([]);expect(f.submitted).toEqual([]);
		expect(f.closedPeers).toBe(1);expect(f.closedLive).toBe(1);
	}finally{await f.runtime.close()}
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
