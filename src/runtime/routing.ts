import { basename } from "node:path";
import type { PendingAsk } from "../index";
import { DecisionCoordinator, type DecisionCall, type Preferences, type SideContext } from "../decisions";
import { openVoice, type VoiceCall, type VoiceOptions } from "../media";
import { NoVoiceAudioError } from "../media/session";
import { startSecureDesktop, type DesktopControl, type SecureDesktop, type SecureDesktopOptions } from "../secure-channel";

export type AskContext = SideContext & VoiceOptions["ctx"] & { cwd:string };
export interface MobileRuntime {
	offer(ask:PendingAsk,ctx:AskContext):void;
	end(requestId:string):void;
	configure(next:Preferences):void;
	pair():Promise<string>;
	close():Promise<void>;
}
type Settings = Pick<SecureDesktopOptions,"url"|"desktopToken"|"stateDir"|"python"|"confirmPair">;
interface Transports { gateway:typeof startSecureDesktop; voice:typeof openVoice }
interface Joined {
	device:string; id:string; decision:DecisionCall; voice?:VoiceCall; streaming:boolean;
}

// A routing grammar for a single English informational question, not an authorization
// predicate. Even an adversarial question reaches only the tool-free decision side turn.
function informationalQuestion(text:string):boolean {
	const q=text.trim();
	if (q.length>1000 || /[\r\n;]/u.test(q)) return false;
	return /^(?:(?:what|why|how|which|when|where|who|whose|is|are|was|were|does|did)\b|do (?:we|I|these|those|the)\b|(?:can|could|would) you (?:please )?(?:explain|clarify|describe|compare|tell me|remind me)\b)[^?!.]+[?.]?$/iu.test(q);
}

/** One host generation. Only the inner TLS endpoint can introduce a paired device.
 * An enrollment made during an Ask is not allowed to acquire that Ask. */
export async function connectRuntime(settings:Settings, initial:Preferences, report:(code:string)=>void, transports:Transports = {
	gateway:startSecureDesktop, voice:openVoice,
}):Promise<MobileRuntime> {
	let gateway:SecureDesktop|undefined, active:Joined|undefined, closed=false;
	const devices=new Set<string>();
	const online=new Set<string>();
	const requests=new Map<string,{ctx:AskContext; audience:Set<string>}>();
	const core=new DecisionCoordinator({
		preferences:initial, error:report,
		async invite(id) {
			const audience=requests.get(id)?.audience;
			if (audience && !closed) await Promise.all([...audience].map(device=>gateway!.ring(device,id)));
		},
		changed() {for (const device of online) inbox(device)},
	});
	function control(device:string, message:DesktopControl) {
		if (!gateway || closed || !online.has(device)) return;
		void gateway.sendControl(device,message).catch(()=>{if (!closed) report("phone-control-unavailable")});
	}
	function inbox(device:string) {
		control(device,{type:"inbox",items:core.list().filter(item=>requests.get(item.requestId)?.audience.has(device))});
	}
	function current(call:Joined) {
		return !closed && active===call && online.has(call.device) && !call.decision.signal.aborted;
	}
	function fail(call:Joined) {
		if (!current(call)) return;
		call.decision.close(); // 'ended' must precede an error, including during the join handshake.
		control(call.device,{type:"error",code:"voice-unavailable"});
	}
	async function join(device:string,id:string,captions=false) {
		const entry=requests.get(id), ctx=entry?.ctx;
		const decision=!active && entry?.audience.has(device) ? core.join(id) : undefined;
		if (!ctx || !decision || !gateway) {control(device,{type:"error",code:"request-unavailable"});return}
		const call:Joined={device,id,decision,streaming:false}; active=call;
		let onset:string|undefined, revision=0;
		decision.signal.addEventListener("abort",()=>{
			if (active!==call) return;
			active=undefined; call.streaming=false;
			control(device,{type:"ended",requestId:id});
			void call.voice?.close().catch(()=>{});
		},{once:true});
		try {
			const brief=await decision.brief();
			if (!current(call)) return;
			const voice=await transports.voice({ctx,brief,signal:decision.signal,
				onCaption:captions ? (role,text,final)=>{
					if (current(call) && call.streaming) control(device,{type:"transcript",requestId:id,role,text,final});
				} : undefined,
				onSpeechStarted(utterance) {
					if (!current(call) || !call.streaming) return;
					++revision; onset=utterance;
					// Snapshot the draft at the caller's onset, not at a later ASR final.
					decision.speechStarted(utterance);
				},
				onTranscript(role,text,utterance) {
					if (!current(call) || !call.streaming || role!=="user") return;
					if (!utterance) {++revision; onset=undefined;decision.interrupt();return}
					if (onset!==utterance) return; // A duplicate final cannot cancel a live consultation.
					onset=undefined;
					if (informationalQuestion(text)) {
						const turn=revision;
						// Consultation invalidates confirmation and cannot submit.
						void decision.consult(text.trim()).then(async answer=>{
							if (current(call) && revision===turn) await call.voice!.sendSpeakable(answer);
						}).catch(()=>{if (current(call) && revision===turn) fail(call)});
						return;
					}
					const turn=revision;
					void decision.speechFinished(utterance,text).then(async reply=>{
						if (!current(call) || revision!==turn || reply.kind!=="say") return;
						await call.voice!.sendSpeakable(reply.text,!!reply.draft);
					}).catch(()=>{if (current(call) && revision===turn) fail(call)});
				},
				onInterrupt() {
					if (!current(call)) return;
					++revision; onset=undefined; decision.interrupt();
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
			await voice.sendSpeakable(decision.opening());
		} catch {fail(call)}
	}
	gateway=await transports.gateway({...settings,onError:report,
		onConnect(device) {if (!closed) {devices.add(device); online.add(device); inbox(device)}},
		onLoss(device) {online.delete(device); if (active?.device===device) active.decision.close()},
		onPcm(device,pcm) {
			const call=active;
			if (call?.device===device && current(call) && call.streaming) {
				try {call.voice!.sendPcm(pcm)} catch {fail(call)}
			}
		},
		async onMessage(device,message) {
			if (closed || !online.has(device)) return;
			switch (message.type) {
				case "list": inbox(device); break;
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
			if (!core.offer(ask,ctx,basename(ctx.cwd))) requests.delete(ask.requestId);
		},
		end(id:string) {
			if (!requests.delete(id)) return;
			core.end(id);
		},
		configure(next:Preferences) {core.configure(next)},
		pair:()=>gateway!.pair(),
		async close() {
			closed=true; online.clear(); requests.clear();
			core.close();
			devices.clear(); await gateway!.close();
		},
	};
}
