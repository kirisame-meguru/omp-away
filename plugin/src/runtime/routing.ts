import * as path from "node:path";
import type { PendingAsk } from "../index";
import { DecisionCoordinator, type QuestionCall, type Preferences } from "../decisions";
import { openVoice, type VoiceCall, type VoiceContext } from "../media";
import { startSecureDesktop, type DesktopControl, type SecureDesktop, type SecureDesktopOptions } from "../secure-channel";

export type AskContext = VoiceContext;
export interface MobileRuntime {
	offer(ask:PendingAsk,ctx:AskContext):void;
	end(requestId:string):void;
	configure(patch:Partial<Preferences>):Promise<void>;
	pair():Promise<string>;
	close():Promise<void>;
}
type Settings=Pick<SecureDesktopOptions,"url"|"desktopToken"|"stateDir"|"python"|"confirmPair"|"onRouting">;
interface Transports {gateway:typeof startSecureDesktop;voice:typeof openVoice}
interface Joined {device:string;id:string;question:QuestionCall;voice?:VoiceCall;streaming:boolean}

export async function connectRuntime(settings:Settings,report:(code:string)=>void,transports:Transports={gateway:startSecureDesktop,voice:openVoice}):Promise<MobileRuntime> {
	let gateway:SecureDesktop|undefined,active:Joined|undefined,closed=false;
	const devices=new Set<string>(),online=new Set<string>(),details=new Set<string>();
	const connections=new Map<string,symbol>();
	const invalidations=new Set<Promise<void>>(),closing=new Set<Promise<void>>();
	const requests=new Map<string,{ctx:AskContext;audience:Set<string>}>();
	const core=new DecisionCoordinator({
		error:report,
		async invite(id) {
			const audience=requests.get(id)?.audience;
			if(audience?.size&&!closed) await Promise.any(Array.from(audience,device=>gateway!.ring(device,id)));
		},
		retired(id) {
			const audience=requests.get(id)?.audience;
			if(!audience||!gateway) return;
			for(const device of audience) {
				const pending=gateway.invalidate(device,id).catch(()=>report("invalidation-unavailable"));
				invalidations.add(pending);void pending.finally(()=>invalidations.delete(pending));
			}
			requests.delete(id);
		},
		changed(){for(const device of online) inbox(device)},
	});
	function control(device:string,message:DesktopControl) {
		if(!gateway||closed||!online.has(device)) return;
		void gateway.sendControl(device,message).catch(()=>{if(!closed) report("phone-control-unavailable")});
	}
	function inbox(device:string) {
		const items=core.list().filter(item=>requests.get(item.requestId)?.audience.has(device));
		const message:DesktopControl={type:"inbox",items};
		if(Buffer.byteLength(JSON.stringify(message))>65536) {control(device,{type:"error",code:"inbox-too-large"});return}
		control(device,message);
		if(details.has(device)) for(const item of items) {
			const display=core.display(item.requestId);
			if(display) control(device,{type:"question",requestId:item.requestId,display});
		}
	}
	function current(call:Joined) {return !closed&&active===call&&online.has(call.device)&&!call.question.signal.aborted}
	function closeVoice(voice:VoiceCall) {
		const pending=voice.close().catch(()=>report("voice-close-unavailable"));
		closing.add(pending);void pending.finally(()=>closing.delete(pending));
	}
	function fail(call:Joined) {
		if(!current(call)) return;
		call.question.close();control(call.device,{type:"error",code:"voice-unavailable"});
	}
	async function join(device:string,id:string,captions=false) {
		const entry=requests.get(id);
		if(entry?.audience.has(device)&&!core.voiceAvailable(id)) {control(device,{type:"error",code:"voice-unavailable"});return}
		const question=!active&&entry?.audience.has(device)?core.join(id):undefined;
		if(!entry||!question||!gateway) {control(device,{type:"error",code:"request-unavailable"});return}
		const call:Joined={device,id,question,streaming:false};active=call;
		question.signal.addEventListener("abort",()=>{
			if(active!==call) return;
			active=undefined;call.streaming=false;
			control(device,{type:"ended",requestId:id});
			if(call.voice) closeVoice(call.voice);
		},{once:true});
		try {
			const voice=await transports.voice({
				ctx:entry.ctx,call:question,
				onCaption:captions?(role,text,final)=>{if(current(call)&&call.streaming) control(device,{type:"transcript",requestId:id,role,text,final})}:undefined,
				onAudio:pcm=>{if(current(call)&&call.streaming) return gateway!.sendPcm(device,pcm)},
				onEnd:reason=>{if(reason) fail(call);else call.question.close()},
			});
			if(!current(call)) {closeVoice(voice);return}
			call.voice=voice;
			await gateway.sendControl(device,{type:"joined",requestId:id});
			if(current(call)) call.streaming=true;
		} catch {fail(call)}
	}
	gateway=await transports.gateway({...settings,onError:report,
		onRouting(next){if(!closed){core.configure(next);settings.onRouting?.(next)}},
		onConnect(device){if(!closed){devices.add(device);online.add(device);connections.set(device,Symbol());inbox(device)}},
		onLoss(device){online.delete(device);connections.delete(device);details.delete(device);if(active?.device===device) active.question.close()},
		onPcm(device,pcm){
			const call=active;
			if(call?.device===device&&current(call)&&call.streaming) {
				try {call.voice!.sendPcm(pcm)} catch {fail(call)}
			}
		},
		async onMessage(device,message){
			if(closed||!online.has(device)) return;
			switch(message.type){
				case "list":if(message.details===true) details.add(device);else details.delete(device);inbox(device);break;
				case "form":
					control(device,{type:"form",requestId:message.requestId,
						form:requests.get(message.requestId)?.audience.has(device)?core.form(message.requestId):null});
					break;
				case "answer": {
					const connection=connections.get(device);
					const result=requests.get(message.requestId)?.audience.has(device)
						? await core.answer(message.requestId,message.values,message.notes)
						: {status:"stale" as const,message:"This request is no longer available."};
					// A delayed receipt belongs only to the authenticated connection that submitted.
					if(connections.get(device)===connection) control(device,{type:"answer",requestId:message.requestId,...result});
					break;
				}
				case "silence":if(requests.get(message.requestId)?.audience.has(device)) core.silence(message.requestId);break;
				case "join":await join(device,message.requestId,message.captions===true);break;
				case "hangup":if(active?.device===device&&active.id===message.requestId) active.question.close();break;
				case "played":break;
			}
		},
	});
	try {for(const device of await gateway.devices()) devices.add(device)}
	catch {closed=true;await gateway.close();throw Error("paired-devices-unavailable")}
	for(const device of online) inbox(device);
	return {
		offer(ask,ctx){
			if(closed||!devices.size||requests.has(ask.requestId)) return;
			requests.set(ask.requestId,{ctx,audience:new Set(devices)});
			let session:string|undefined;
			try {
				const name=ctx.sessionManager.getSessionName?.();
				if(typeof name==="string"&&name.trim()&&!/[\u0000-\u001f\u007f/\\]|:\/\/|^[A-Za-z]:/.test(name)) session=name.trim();
			} catch {}
			if(!core.offer(ask,ctx,path.basename(ctx.cwd),session)) requests.delete(ask.requestId);
		},
		end:id=>core.end(id),
		async configure(patch){if(closed) throw Error("runtime-closed");await gateway!.routing(patch)},
		pair:()=>gateway!.pair(),
		async close(){
			if(closed) return;
			closed=true;connections.clear();core.close();online.clear();details.clear();requests.clear();devices.clear();
			await Promise.all(invalidations);await gateway!.close();await Promise.all(closing);
		},
	};
}
