import * as path from "node:path";
import type { PendingAsk } from "../index";
import { DecisionCoordinator, type DecisionCall, type Preferences, type SideContext } from "../decisions";
import { openVoice, type VoiceCall, type VoiceOptions } from "../media";
import { NoVoiceAudioError } from "../media/session";
import { startSecureDesktop, type DesktopControl, type SecureDesktop, type SecureDesktopOptions } from "../secure-channel";
import { openCallLog, type CallLog } from "../media/call-log";

export type AskContext = SideContext & VoiceOptions["ctx"] & { cwd:string };
export interface MobileRuntime {
	offer(ask:PendingAsk,ctx:AskContext):void;
	end(requestId:string):void;
	configure(patch:Partial<Preferences>):Promise<void>;
	pair():Promise<string>;
	close():Promise<void>;
}
type Settings = Pick<SecureDesktopOptions,"url"|"desktopToken"|"stateDir"|"python"|"confirmPair"|"onRouting">;
interface Transports { gateway:typeof startSecureDesktop; voice:typeof openVoice }
interface Joined {
	device:string; id:string; decision:DecisionCall; voice?:VoiceCall; streaming:boolean;
	log?:CallLog; operations:number;
}

// A fast path for English informational requests, not an authorization predicate.
// Even an adversarial request reaches only the tool-free decision side turn.
function informationalRequest(text:string):boolean {
	const q=text.trim();
	if (q.length>1000 || /[\r\n;]/u.test(q)) return false;
	return /^(?:(?:what|why|how|which|when|where|who|whose|is|are|was|were|does|did)\b|do (?:we|I|these|those|the)\b|(?:please )?(?:(?:can|could|would) you (?:please )?)?(?:explain|clarify|describe|compare|tell me|remind me|suggest|recommend|(?:ask|consult|check with) (?:the )?(?:main (?:model|agent)|coding session))\b)[^?!.]+[?.]?$/iu.test(q);
}

/** One host generation. Only the inner TLS endpoint can introduce a paired device.
 * An enrollment made during an Ask is not allowed to acquire that Ask. */
export async function connectRuntime(settings:Settings, report:(code:string)=>void, transports:Transports = {
	gateway:startSecureDesktop, voice:openVoice,
}):Promise<MobileRuntime> {
	let gateway:SecureDesktop|undefined, active:Joined|undefined, closed=false;
	const devices=new Set<string>();
	const online=new Set<string>();
	const details=new Set<string>();
	const invalidations=new Set<Promise<void>>();
	const logs=new Set<CallLog>();
	const requests=new Map<string,{ctx:AskContext; audience:Set<string>}>();
	const core=new DecisionCoordinator({
		error:report,
		async invite(id) {
			const audience=requests.get(id)?.audience;
			if (audience && !closed) await Promise.all([...audience].map(device=>gateway!.ring(device,id)));
		},
		retired(id) {
			const audience=requests.get(id)?.audience;
			if (!audience || !gateway) return;
			// Invoke while the birth audience is still owned, including offline phones.
			for (const device of audience) {
				const pending=gateway.invalidate(device,id).catch(()=>report("invalidation-unavailable"));
				invalidations.add(pending);
				void pending.finally(()=>invalidations.delete(pending));
			}
			requests.delete(id);
		},
		changed() {for (const device of online) inbox(device)},
	});
	function control(device:string, message:DesktopControl) {
		if (!gateway || closed || !online.has(device)) return;
		void gateway.sendControl(device,message).catch(()=>{if (!closed) report("phone-control-unavailable")});
	}
	function inbox(device:string) {
		const items=core.list().filter(item=>requests.get(item.requestId)?.audience.has(device));
		const message:DesktopControl={type:"inbox",items};
		// A partial snapshot would falsely retire omitted requests on every handset.
		if (Buffer.byteLength(JSON.stringify(message))>65_536) {
			control(device,{type:"error",code:"inbox-too-large"}); return;
		}
		control(device,message);
		if (details.has(device)) for (const item of items) {
			const display=core.display(item.requestId);
			if (display) control(device,{type:"question",requestId:item.requestId,display});
		}
	}
	function proposal(device:string,id:string,text="") {
		if (details.has(device) && requests.get(id)?.audience.has(device))
			control(device,{type:"proposal",requestId:id,text:text.length<=8192 && !text.includes("\0") ? text : ""});
	}
	function current(call:Joined) {
		return !closed && active===call && online.has(call.device) && !call.decision.signal.aborted;
	}
	function closeLog(call:Joined) {
		// Native submission aborts the call before its result promise settles.
		if (!call.decision.signal.aborted || call.operations || !call.log) return;
		const log=call.log; call.log=undefined;
		void log.close().finally(()=>logs.delete(log));
	}
	function fail(call:Joined) {
		if (!current(call)) return;
		call.log?.event("voice-failed");
		call.decision.close(); // 'ended' must precede an error, including during the join handshake.
		control(call.device,{type:"error",code:"voice-unavailable"});
	}
	async function join(device:string,id:string,captions=false) {
		const entry=requests.get(id), ctx=entry?.ctx;
		if (entry?.audience.has(device) && !core.voiceAvailable(id)) {
			control(device,{type:"error",code:"voice-unavailable"}); return;
		}
		const decision=!active && entry?.audience.has(device) ? core.join(id) : undefined;
		if (!ctx || !decision || !gateway) {control(device,{type:"error",code:"request-unavailable"});return}
		const call:Joined={device,id,decision,streaming:false,operations:0}; active=call;
		let onset:string|undefined, revision=0;
		decision.signal.addEventListener("abort",()=>{
			if (active!==call) return;
			active=undefined; call.streaming=false;
			call.log?.event("ended"); closeLog(call);
			proposal(device,id);
			control(device,{type:"ended",requestId:id});
			void call.voice?.close().catch(()=>{});
		},{once:true});
		try {
			const brief=await decision.brief();
			if (!current(call)) return;
			if(settings.stateDir) {
				call.log=await openCallLog(path.join(settings.stateDir,"calls"),id,ctx.sessionManager.getSessionId()??"");
				if(call.log) logs.add(call.log);
				if(!current(call)) {call.log?.event("ended");closeLog(call);return}
			}
			const voice=await transports.voice({ctx,brief,signal:decision.signal,log:call.log,
				onCaption:captions ? (role,text,final)=>{
					if (current(call) && call.streaming) control(device,{type:"transcript",requestId:id,role,text,final});
				} : undefined,
				onSpeechStarted(utterance,startedAt) {
					if (!current(call) || !call.streaming) return;
					++revision; onset=utterance;
					// Snapshot the draft at the caller's onset, not at a later ASR final.
					decision.speechStarted(utterance,startedAt);
				},
				onTranscript(role,text,utterance) {
					if (!current(call) || !call.streaming || role!=="user") return;
					if (!utterance) {call.log?.event("caller-unbound");++revision; onset=undefined;decision.interrupt();proposal(device,id);return}
					// A duplicate final cannot cancel a live consultation.
					if (onset!==utterance) {call.log?.event("caller-stale");return}
					onset=undefined;
					if (informationalRequest(text)) {
						const turn=revision;
						++call.operations; call.log?.event("consult-started");
						// Consultation invalidates confirmation and cannot submit.
						proposal(device,id);
						void decision.consult(text.trim()).then(async answer=>{
							call.log?.event(current(call) && revision===turn ? "consult-finished" : "consult-interrupted");
							if (current(call) && revision===turn) await call.voice!.sendSpeakable(answer);
						}).catch(()=>{
							call.log?.event(current(call) && revision===turn ? "consult-failed" : "consult-interrupted");
							if (current(call) && revision===turn) fail(call);
						}).finally(()=>{--call.operations;closeLog(call)});
						return;
					}
					const turn=revision;
					++call.operations; call.log?.event("decision-started");
					void decision.speechFinished(utterance,text).then(async reply=>{
						call.log?.event("decision-reply",reply.kind,reply.kind==="say" && !!reply.draft);
						if (!current(call) || revision!==turn || reply.kind!=="say") return;
						proposal(device,id,reply.draft?.map(field=>`${field.field}: ${Array.isArray(field.answer) ? field.answer.join("; ") : field.answer ?? "No answer"}`).join("\n") ?? "");
						await call.voice!.sendSpeakable(reply.text,!!reply.draft);
					}).catch(()=>{
						call.log?.event("decision-failed");
						if (current(call) && revision===turn) fail(call);
					}).finally(()=>{--call.operations;closeLog(call)});
				},
				onInterrupt() {
					if (!current(call)) return;
					++revision; onset=undefined; decision.interrupt();
					proposal(device,id);
				},
				onAudio(pcm) {
					if (current(call) && call.streaming) return gateway!.sendPcm(device,pcm).catch(()=>fail(call));
				},
				onEnd:reason=>{
					if (current(call) && reason instanceof NoVoiceAudioError) report("No speech audio arrived from the voice service");
					fail(call);
				},
			});
			if (!current(call)) {await voice.close();return}
			call.voice=voice;
			await gateway.sendControl(device,{type:"joined",requestId:id});
			if (!current(call)) return;
			call.streaming=true;
			call.log?.event("joined");
			await voice.sendSpeakable(decision.opening());
		} catch {fail(call)}
	}
	gateway=await transports.gateway({...settings,onError:report,
		onRouting(next) {
			if (closed) return;
			core.configure(next);
			settings.onRouting?.(next);
		},
		onConnect(device) {if (!closed) {devices.add(device); online.add(device); inbox(device)}},
		onLoss(device) {online.delete(device); details.delete(device); if (active?.device===device) active.decision.close()},
		onPcm(device,pcm) {
			const call=active;
			if (call?.device===device && current(call) && call.streaming) {
				try {call.voice!.sendPcm(pcm)} catch {fail(call)}
			}
		},
		async onMessage(device,message) {
			if (closed || !online.has(device)) return;
			switch (message.type) {
				case "list":
					if (message.details===true) details.add(device); else details.delete(device);
					inbox(device); break;
				case "silence": if (requests.get(message.requestId)?.audience.has(device)) core.silence(message.requestId); break;
				case "join": await join(device,message.requestId,message.captions===true); break;
				case "hangup": if (active?.device===device && active.id===message.requestId) active.decision.close(); break;
				// Old handset acknowledgments are compatibility traffic, not authorization.
				case "played": break;
			}
		},
	});
	try {for (const device of await gateway.devices()) devices.add(device)}
	catch {closed=true; await gateway.close(); throw Error("paired-devices-unavailable")}
	for (const device of online) inbox(device);
	return {
		offer(ask:PendingAsk,ctx:AskContext) {
			if (closed || !devices.size || requests.has(ask.requestId)) return;
			requests.set(ask.requestId,{ctx,audience:new Set(devices)});
			let session:string|undefined;
			try {
				const name=ctx.sessionManager.getSessionName?.();
				if (typeof name==="string" && name.trim() && !/[\u0000-\u001f\u007f/\\]|:\/\/|^[A-Za-z]:/.test(name)) session=name.trim();
			} catch { /* Older hosts may not expose a display name; project remains the fallback. */ }
			if (!core.offer(ask,ctx,path.basename(ctx.cwd),session)) requests.delete(ask.requestId);
		},
		end(id:string) {
			core.end(id);
		},
		async configure(patch) {
			if (closed) throw Error("runtime-closed");
			await gateway!.routing(patch);
		},
		pair:()=>gateway!.pair(),
		async close() {
			if (closed) return;
			closed=true;
			core.close(); // Capture all authorized audiences before discarding their capabilities.
			online.clear(); details.clear(); requests.clear(); devices.clear();
			await Promise.all(invalidations);
			await gateway!.close();
			await Promise.all([...logs].map(log=>log.close())); logs.clear();
		},
	};
}
