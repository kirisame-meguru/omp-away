import consult from "../../prompts/decisions/consult.md" with { type: "text" };
import extract from "../../prompts/decisions/extract.md" with { type: "text" };
import verify from "../../prompts/decisions/verify.md" with { type: "text" };
import { logger } from "@oh-my-pi/pi-utils";
import type { DecisionForm } from "./form";

export interface SideContext {
	runEphemeralTurn?(options:{promptText:string;tools:false;signal:AbortSignal;purpose:string;dedupeReply:false;maxContextBytes:number;minimizeEffort?:boolean;onTextDelta:(text:string)=>void}):Promise<{replyText:string;assistantMessage:{stopReason:string}}>;
}
type SidePurpose="consult"|"extract"|"verify";
const prompts = {consult,extract,verify};
export type Exchange = {question:string; answer:string};
export async function untilAbort<T>(start:()=>Promise<T>|T, signal:AbortSignal):Promise<T> {
	signal.throwIfAborted();
	const done=Promise.withResolvers<T>();
	const stop=()=>done.reject(Error("side-turn-ended"));
	signal.addEventListener("abort",stop,{once:true});
	try {
		// Install the cancellation waiter before calling into a potentially reentrant provider.
		try { Promise.resolve(start()).then(done.resolve,done.reject); }
		catch(error) { done.reject(error); }
		return await done.promise;
	} finally { signal.removeEventListener("abort",stop); }
}
/** The only model boundary. No sendUserMessage, live delegation, tools or main-session mutation. */
export async function side(ctx: SideContext, form: DecisionForm, kind:SidePurpose, data: Record<string,unknown>, signal: AbortSignal): Promise<string> {
	const byteCap = kind === "consult" ? 2048 : 8192;
	signal.throwIfAborted();
	const started=performance.now();
	let completed=false;
	const operation=new AbortController();
	const stop=()=>operation.abort();
	signal.addEventListener("abort",stop,{once:true});
	const timeout=setTimeout(stop,60_000);
	let received=0;
	try {
		const result=await untilAbort(()=>ctx.runEphemeralTurn?.({promptText:`${prompts[kind]}\nForm: ${form.description}\n${JSON.stringify(data)}`,tools:false,signal:operation.signal,purpose:`away-${kind}`,maxContextBytes:4*1024*1024,minimizeEffort:kind==="extract",dedupeReply:false,onTextDelta(text){
			received+=Buffer.byteLength(text);
			if(received>byteCap) throw Error("reply-too-large");
		}}),operation.signal);
		operation.signal.throwIfAborted();
		if(result?.assistantMessage?.stopReason!=="stop" || typeof result.replyText!=="string") throw Error();
		const text=result.replyText.trim();
		if(!text || Buffer.byteLength(text)>byteCap) throw Error();
		completed=true;
		return text;
	} catch { throw Error(`${kind}-unavailable`); }
	finally {
		clearTimeout(timeout); signal.removeEventListener("abort",stop);
		logger.debug("Away decision timing",{stage:kind,elapsedMs:Math.round(performance.now()-started),completed});
	}
}
