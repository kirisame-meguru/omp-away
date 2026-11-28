import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type as arktype } from "@oh-my-pi/omptype";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as registry from "@oh-my-pi/pi-coding-agent/config/registry";
import away, { type PendingAsk } from "../src";
import * as runtime from "../src/runtime";
import type { QuestionSource } from "../src/runtime/async-ask";
import * as adapter from "../src/collab/adapter";
import { connectRuntime } from "../src/runtime/routing";
import { fieldQuestions } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import type { DesktopControl, SecureDesktopOptions } from "../src/secure-channel";

afterEach(() => mock.restore());

test("async offers work without native Collab, survive agent end and cannot outlive the Away session", async () => {
	spyOn(registry, "lookup").mockReturnValue(undefined);
	spyOn(runtime, "gatewayConfigured").mockReturnValue(true);
	const offered: PendingAsk[] = [], ended: string[] = [];
	let submitted = 0, closed = 0;
	spyOn(runtime, "openAdmin").mockResolvedValue({
		offer(ask) { offered.push(ask); }, end(id) { ended.push(id); },
		async endCall() { return false; }, async call() { return "unavailable" as const; },
		async close() { closed++; }, async command() {}, cancelEnrollment() {},
	});
	const events = new EventBus();
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler>();
	const ctx = {
		agent: { kind: "main" }, mode: "tui", isIdle: () => false,
		sessionManager: { getSessionId: () => "owner" }, ui: { notify() {} },
	} as unknown as ExtensionContext;
	const source: QuestionSource = {
		version: 1, sessionId: "owner", signal: new AbortController().signal,
		subscribe(listener) {
			listener([{
				id: "canonical", requestId: crypto.randomUUID(), toolCallId: "async-tool", title: "Choose target", blockedWork: "Deployment", createdAt: Date.now(),
				html: '<form><label>Target<input name="target" required></label></form>',
				submitConfirmed() { submitted++; return { kind: "accepted", answerId: "answer", delivery: "queued" }; },
			}]);
			return () => {};
		},
	};
	const off = events.on("omp-async-ask:connect:v1", request => {
		if (request && typeof request === "object" && "accept" in request && typeof request.accept === "function") request.accept(source);
	});
	const api = { events, arktype, registerMessageRenderer() {}, registerTool() {}, registerCommand() {}, on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
	away(api);
	try {
		await handlers.get("session_start")!({}, ctx);
		expect(offered).toHaveLength(1);
		await handlers.get("agent_end")!({}, ctx);
		expect(ended).toEqual([]);
		await handlers.get("session_shutdown")!({}, ctx);
		expect(ended).toEqual([offered[0]!.requestId]);
		expect(closed).toBe(1);
		expect(await offered[0]!.submitConfirmed(offered[0]!.requestId, { target: "late" })).toBe("stale");
		expect(submitted).toBe(0);
	} finally { off(); await handlers.get("session_shutdown")!({}, ctx); }
});

test.each(["desktop-answer","cancel","room-loss","agent-end","shutdown"])("native %s retires the real offered capability and wakes only its audience",async reason=>{
	const settings=new Map<string,registry.AnySetting>();
	for (const [id,value] of Object.entries({"collab.autoStart":"control","ask.timeout":0,"collab.relayUrl":"ws://127.0.0.1:12345"})) {
		const setting=new registry.Setting<unknown>(typeof value==="number" ? {id,type:"number",default:value} : {id,type:"string",default:value});
		spyOn(setting,"get").mockReturnValue(value);
		settings.set(id,setting);
	}
	spyOn(registry,"lookup").mockImplementation(key=>settings.get(key));
	spyOn(runtime,"gatewayConfigured").mockReturnValue(true);
	let native!:{request(value:CollabUiRequest):void;end(id:number):void;lost():void}, wire!:SecureDesktopOptions;
	let mobileOpening:ReturnType<typeof connectRuntime>|undefined;
	const invalidations:string[][]=[], controls:DesktopControl[]=[];
	spyOn(adapter,"startAdapter").mockImplementation(async(port,_session,callbacks)=>{
		native=callbacks; callbacks.ready?.();
		return {port,async reply(){return true},async close(){}};
	});
	spyOn(runtime,"openAdmin").mockImplementation(async()=>{
		const mobile=await (mobileOpening=connectRuntime({url:"https://example.invalid",desktopToken:"",stateDir:"",confirmPair:async()=>false},()=>{},{
			async gateway(options) {wire=options;return {
				async devices(){return ["phone"]},async pair(){throw Error("unexpected pairing")},
				async routing(){return {away:true,delayMs:null}},async ring(){},async invalidate(device,id){invalidations.push([device,id])},
				async sendControl(_device,message){controls.push(message)},async sendPcm(){},async close(){},
			}},
			async voice(){throw Error("read-only detail must not open voice")},
		}));
		return {...mobile,async command(){},cancelEnrollment(){}};
	});
	type Handler=(event:unknown,ctx:ExtensionContext)=>unknown;
	const handlers=new Map<string,Handler>();
	const events=new EventBus();
	const ctx={cwd:"/example/project",agent:{kind:"main"},mode:"tui",isIdle:()=>true,
		sessionManager:{getSessionId:()=>"owner",getSessionName:()=>"Native review"},ui:{notify(){}}} as unknown as ExtensionContext;
	const api={events,arktype,registerMessageRenderer(){},registerTool(){},pi:{settings:{}},registerCommand(){},getAllTools(){return [{name:"ask",sourceInfo:{source:"builtin",path:"<builtin:ask>"}}]},
		on(name:string,handler:Handler){handlers.set(name,handler)}} as unknown as ExtensionAPI;
	away(api);
	try {
		await handlers.get("session_start")!({},ctx);
		await mobileOpening;
		await tick(); // Finish host registration after asynchronous locale preferences load.
		const transformed=await handlers.get("tool_call")!({toolName:"ask",toolCallId:"tool",input:{html:'<form><label>Explain<textarea name="answer"></textarea></label></form>'}},ctx);
		if (!transformed || typeof transformed!=="object" || !("input" in transformed) || !transformed.input || typeof transformed.input!=="object" || !("html" in transformed.input) || typeof transformed.input.html!=="string") throw Error("Native form was not prepared");
		const html=transformed.input.html;
		await handlers.get("tool_execution_start")!({toolName:"ask",toolCallId:"tool",args:{html}},ctx);
		const title=[...fieldQuestions(parseHtmlForm(html)).values()][0]!;
		native.request({kind:"editor",reqId:1,title,prefill:""});
		wire.onConnect?.("phone"); await wire.onMessage("phone",{type:"list",details:true});
		const detail=controls.find(message=>message.type==="question");
		expect(detail).toMatchObject({type:"question",display:{fields:[{label:"Explain",kind:"text"}]}});
		if (!detail || detail.type!=="question") throw Error("No native detail");
		wire.onConnect?.("later-phone"); wire.onLoss("phone");
		if (reason==="desktop-answer") await handlers.get("tool_execution_end")!({toolName:"ask",toolCallId:"tool",isError:false,result:{content:[{type:"text",text:'User answers:\n{"answer":"Local answer"}'}],details:{answers:[]}}},ctx);
		if (reason==="cancel") native.end(1);
		if (reason==="room-loss") native.lost();
		if (reason==="agent-end") await handlers.get("agent_end")!({},ctx);
		if (reason==="shutdown") await handlers.get("session_shutdown")!({},ctx);
		expect(invalidations).toEqual([["phone",detail.requestId]]);
	} finally {await handlers.get("session_shutdown")!({},ctx)}
});

test("assistant hangup is explicit, session-owned and cancellation-safe",async()=>{
	spyOn(registry,"lookup").mockReturnValue(undefined);
	spyOn(runtime,"gatewayConfigured").mockReturnValue(true);
	const ended:string[]=[];
	spyOn(runtime,"openAdmin").mockResolvedValue({
		offer(){},end(){},async endCall(id){ended.push(id);return id==="active"},async call(){return "unavailable" as const},
		async close(){},async command(){},cancelEnrollment(){},
	});
	const handlers=new Map<string,(event:unknown,ctx:ExtensionContext)=>unknown>();
	let tool!:ToolDefinition;
	const api={events:new EventBus(),arktype,registerCommand(){},registerMessageRenderer(){},
		registerTool(value:ToolDefinition){tool=value},
		on(name:string,handler:(event:unknown,ctx:ExtensionContext)=>unknown){handlers.set(name,handler)},
	} as unknown as ExtensionAPI;
	const ctx={agent:{kind:"main"},mode:"tui",isIdle:()=>false,
		sessionManager:{getSessionId:()=>"owner"},ui:{notify(){}}} as unknown as ExtensionContext;
	away(api);
	try {
		await handlers.get("session_start")!({},ctx);
		expect(tool.name).toBe("away_end_call");expect(tool.loadMode).toBe("essential");
		const invoke=(id:string,context=ctx,signal?:AbortSignal)=>tool.execute("end",{requestId:id},signal,undefined,context);
		expect((await invoke("active",{...ctx,agent:{...ctx.agent,kind:"sub"}})).details).toEqual({ended:false});
		expect((await invoke("active",{...ctx,sessionManager:{...ctx.sessionManager,getSessionId:()=>"other"}})).details).toEqual({ended:false});
		await expect(invoke("active",ctx,AbortSignal.abort())).rejects.toThrow();
		expect(ended).toEqual([]);
		await handlers.get("agent_end")!({},ctx);
		expect(ended).toEqual([]); // A completed backend turn is not proof the voice has finished speaking.
		expect((await invoke("active")).details).toEqual({ended:true});
		expect((await invoke("stale")).details).toEqual({ended:false});
		expect(ended).toEqual(["active","stale"]);
		await handlers.get("session_shutdown")!({},ctx);
		expect((await invoke("active")).details).toEqual({ended:false});
		expect(ended).toEqual(["active","stale"]);
	} finally {await handlers.get("session_shutdown")!({},ctx)}
});

test("away_call requires a forwarded async question or arms only the next native ask",async()=>{
	const settings=new Map<string,registry.AnySetting>();
	for (const [id,value] of Object.entries({"collab.autoStart":"control","ask.timeout":0,"collab.relayUrl":"ws://127.0.0.1:12345"})) {
		const setting=new registry.Setting<unknown>(typeof value==="number" ? {id,type:"number",default:value} : {id,type:"string",default:value});
		spyOn(setting,"get").mockReturnValue(value);
		settings.set(id,setting);
	}
	spyOn(registry,"lookup").mockImplementation(key=>settings.get(key));
	spyOn(runtime,"gatewayConfigured").mockReturnValue(true);
	let native!:{request(value:CollabUiRequest):void};
	spyOn(adapter,"startAdapter").mockImplementation(async(port,_session,callbacks)=>{
		native=callbacks; callbacks.ready?.();
		return {port,async reply(){return true},async close(){}};
	});
	const offered:PendingAsk[]=[], called:string[]=[];
	spyOn(runtime,"openAdmin").mockResolvedValue({
		offer(ask){offered.push(ask)},end(){},async endCall(){return false},
		async call(id){called.push(id);return "declined"},
		async close(){},async command(){},cancelEnrollment(){},
	});
	const events=new EventBus();
	const off=events.on("omp-async-ask:connect:v1",request=>{
		if (request && typeof request==="object" && "accept" in request && typeof request.accept==="function") request.accept({
			version:1,sessionId:"owner",signal:new AbortController().signal,
			subscribe(listener:(questions:unknown[])=>void){listener([{id:"canonical",requestId:"async-request",toolCallId:"async-tool",title:"Pick",blockedWork:"Work",createdAt:1,
				html:'<form><label>Target<input name="target"></label></form>',submitConfirmed(){return {kind:"stale"}}}]);return ()=>{}},
		});
	});
	const handlers=new Map<string,(event:unknown,ctx:ExtensionContext)=>unknown>();
	const tools=new Map<string,ToolDefinition>();
	const api={events,arktype,registerCommand(){},registerMessageRenderer(){},pi:{settings:{}},
		getAllTools(){return [{name:"ask",sourceInfo:{source:"builtin",path:"<builtin:ask>"}}]},
		registerTool(value:ToolDefinition){tools.set(value.name,value)},
		on(name:string,handler:(event:unknown,ctx:ExtensionContext)=>unknown){handlers.set(name,handler)},
	} as unknown as ExtensionAPI;
	const ctx={cwd:"/example",agent:{kind:"main"},mode:"tui",isIdle:()=>true,
		sessionManager:{getSessionId:()=>"owner"},ui:{notify(){}}} as unknown as ExtensionContext;
	away(api);
	try {
		await handlers.get("session_start")!({},ctx);
		const tool=tools.get("away_call")!;
		expect(tool.loadMode).toBeUndefined();
		const invoke=(params:object,context=ctx)=>tool.execute("call",params,undefined,undefined,context);
		await expect(invoke({})).rejects.toThrow("exactly one");
		await expect(invoke({questionId:"canonical",nativeAsk:true})).rejects.toThrow("exactly one");
		await expect(invoke({questionId:"unknown"})).rejects.toThrow("No pending async question");
		await expect(invoke({questionId:"canonical"},{...ctx,agent:{kind:"sub"}} as unknown as ExtensionContext)).rejects.toThrow("unavailable");
		expect((await invoke({questionId:"canonical"})).details).toEqual({outcome:"declined"});
		expect(called).toEqual(["async-request"]);

		// Arming alone rings nothing; the next native ask offered in this turn rings once.
		expect((await invoke({nativeAsk:true})).details).toEqual({outcome:"armed"});
		expect(called).toEqual(["async-request"]);
		const prepare=async(id:string)=>{
			const result=await handlers.get("tool_call")!({toolName:"ask",toolCallId:id,input:{html:'<form><label>Explain<textarea name="answer"></textarea></label></form>'}},ctx) as {input:{html:string}};
			await handlers.get("tool_execution_start")!({toolName:"ask",toolCallId:id,args:{html:result.input.html}},ctx);
			native.request({kind:"editor",reqId:Number(id.slice(-1)),title:[...fieldQuestions(parseHtmlForm(result.input.html)).values()][0]!,prefill:""});
		};
		await prepare("tool1");
		const nativeRequest=offered.at(-1)!.requestId;
		await tick();
		expect(called).toEqual(["async-request",nativeRequest]);
		await handlers.get("tool_execution_end")!({toolName:"ask",toolCallId:"tool1",isError:true,result:{}},ctx);
		await prepare("tool2");
		await tick();
		expect(called).toHaveLength(2);
		// Agent end discards an unused arm.
		await invoke({nativeAsk:true});
		await handlers.get("tool_execution_end")!({toolName:"ask",toolCallId:"tool2",isError:true,result:{}},ctx);
		await handlers.get("agent_end")!({},ctx);
		await prepare("tool3");
		await tick();
		expect(called).toHaveLength(2);
	} finally {off();await handlers.get("session_shutdown")!({},ctx)}
});
