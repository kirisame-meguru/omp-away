import * as path from "node:path";
import { spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import type { PendingAsk } from "../index";
import { DecisionCoordinator, type QuestionCall, type Preferences } from "../decisions";
import { displayExcerpt } from "../decisions/display";
import { openVoice, type VoiceCall, type VoiceContext } from "../media";
import { startSecureDesktop, type DesktopControl, type SecureDesktop, type SecureDesktopOptions } from "../secure-channel";
import type { AwayNotifications } from "./notifications";
import { isLanguage, LanguageStore, type Language } from "../language";
import { message as localize } from "../messages";
import { translatePresentation, type Presentation } from "../translate";

export type AskContext = VoiceContext;
export interface MobileRuntime {
	readonly ringing?:boolean;
	offer(ask:PendingAsk,ctx:AskContext):void;
	end(requestId:string):void;
	endCall(requestId:string):Promise<boolean>;
	configure(patch:Partial<Preferences>):Promise<void>;
	pair():Promise<string>;
	close():Promise<void>;
}
type Settings=Pick<SecureDesktopOptions,"url"|"desktopToken"|"stateDir"|"python"|"confirmPair"|"onRouting"> & {notifications?:AwayNotifications;onLanguage?(language:Language):void};
interface Transports {gateway:typeof startSecureDesktop;voice:typeof openVoice}
interface Joined {device:string;id:string;question:QuestionCall;voice?:VoiceCall;streaming:boolean}
interface Translation { promise:Promise<Presentation>; value?:Presentation }

export async function connectRuntime(settings:Settings,report:(code:string,requestId?:string)=>void,transports:Transports={gateway:startSecureDesktop,voice:openVoice}):Promise<MobileRuntime> {
	const languages=new LanguageStore(settings.stateDir);
	try {await languages.load()} catch {report("language-preference-unavailable")}
	settings.onLanguage?.(languages.get());
	let gateway:SecureDesktop|undefined,active:Joined|undefined,closed=false,helperAvailable=true;
	let relay:"unknown"|"connected"|"reconnecting"="unknown";
	let relayHealth=false,legacyRelayInterrupted=false;
	let prefs:Preferences={away:false,delayMs:null};
	const feedback=settings.notifications;
	const devices=new Set<string>(),online=new Set<string>(),details=new Set<string>();
	const connections=new Map<string,symbol>();
	const invalidations=new Set<Promise<void>>(),closing=new Set<Promise<void>>();
	const requests=new Map<string,{ctx:AskContext;audience:Set<string>;abort:AbortController;translations:Map<Language,Translation>}>();
	const core=new DecisionCoordinator({
		error(code,id){if(code!=="unsupported-form" || prefs.away || prefs.delayMs!==null) report(code,id)},
		async invite(id) {
			const audience=requests.get(id)?.audience;
			state();
			if(audience?.size&&!closed) {
				await Promise.any(Array.from(audience,device=>gateway!.ring(device,id)));
				if(!closed) feedback?.recover("invite");
			}
		},
		retired(id) {
			const audience=requests.get(id)?.audience;
			requests.get(id)?.abort.abort();
			if(!audience||!gateway) return;
			for(const device of audience) {
				const pending=gateway.invalidate(device,id).catch(()=>{if(!closed) report("invalidation-unavailable")});
				invalidations.add(pending);void pending.finally(()=>invalidations.delete(pending));
			}
			requests.delete(id);
		},
		changed(){for(const device of online) inbox(device);state()},
	});
	function impairedWork() {
		return !closed && (!helperAvailable || relay==="reconnecting") && core.expectsMobile();
	}
	function state() {
		if(closed) return;
		feedback?.health("Mobile gateway",helperAvailable?"Available":"Unavailable; restart Away after checking gateway settings");
		feedback?.health("Relay",!helperAvailable?"Unavailable (gateway stopped)":relay==="unknown"
			? legacyRelayInterrupted?"Last connection interrupted; recovery reporting unavailable (older gateway)":"Health reporting unavailable (older gateway)"
			: relay==="connected"?"Connected":"Reconnecting");
		feedback?.health("Phones",language=>language==="ru"
			? `Подключено: ${online.size}; сопряжённых устройств: ${devices.size}. Отключение в режиме ожидания — нормально`
			: `${online.size} connected, ${devices.size} known paired; idle disconnection is normal`);
		feedback?.health("This session",language=>language==="ru"
			? `Ожидающих вопросов: ${core.pendingCount}; ${active?"идёт звонок":"нет активного звонка"}`
			: `${core.pendingCount} pending mobile questions; ${active?"call active":"no active call"}`);
		if(impairedWork()) feedback?.defer("mobile-outage","Mobile forwarding is unavailable for pending questions. Use the desktop or /questions; inspect /away status.",impairedWork);
		else feedback?.cancel("mobile-outage");
	}
	function control(device:string,message:DesktopControl) {
		if(!gateway||closed||!online.has(device)) return;
		const localized=message.type==="answer"?{...message,message:localize(languages.get(device),message.message)}:message;
		void gateway.sendControl(device,localized).catch(()=>{
			if(closed) return;
			report("phone-control-unavailable");
			if(message.type==="answer" && (message.status==="accepted" || message.status==="uncertain")) report("answer-receipt-unavailable",message.requestId);
		});
	}
	function answerLabels(id:string,language:Language):ReadonlyMap<string,string>|undefined {
		const form=requests.get(id)?.translations.get(language)?.value?.form;
		if(!form) return;
		const labels=new Map<string,string>();
		for(const section of form.sections) for(const block of section.blocks) {
			if(block.kind!=="field") continue;
			const field=block.field;
			const label="question" in field&&typeof field.question==="string"?field.question:spansText(field.label);
			if(label.trim()) labels.set(field.name,label);
		}
		return labels;
	}
	function presentation(id:string,language:Language):Translation|undefined {
		const entry=requests.get(id);
		if(!entry) return;
		const cached=entry.translations.get(language);
		if(cached) return cached;
		const original:Presentation={title:core.list().find(item=>item.requestId===id)?.question??"",
			form:core.form(id),display:core.display(id)};
		const signal=AbortSignal.any([entry.abort.signal,AbortSignal.timeout(20000)]);
		const translated:Translation={promise:translatePresentation(entry.ctx,language,original,signal).catch(()=>{
			if(!entry.abort.signal.aborted&&!closed) report("translation-unavailable",id);
			const notice=localize(language,"Translation unavailable. Showing the original question.");
			return {...original,
				form:original.form?{...original.form,description:notice+(original.form.description?"\n\n"+original.form.description:"")}:null,
				display:original.display&&original.display.context.length+notice.length+2<=8192
					?{...original.display,context:notice+(original.display.context?"\n\n"+original.display.context:"")}:original.display};
		})};
		entry.translations.set(language,translated);
		void translated.promise.then(value=>{
			translated.value=value;
			if(closed||requests.get(id)!==entry) return;
			for(const device of online) if(entry.audience.has(device)&&languages.selected(device)===language) inbox(device);
		});
		return translated;
	}
	function inbox(device:string) {
		const language=languages.selected(device);
		const originals=core.list().filter(item=>requests.get(item.requestId)?.audience.has(device));
		const items=originals.map(item=>{
			const translated=language?presentation(item.requestId,language)?.value:undefined;
			return translated?{...item,question:displayExcerpt(translated.title,256)}:item;
		});
		const message:DesktopControl={type:"inbox",items};
		if(Buffer.byteLength(JSON.stringify(message))>65536) {control(device,{type:"error",code:"inbox-too-large"});return}
		control(device,message);
		if(details.has(device)) for(const item of items) {
			const translated=language?requests.get(item.requestId)?.translations.get(language)?.value:undefined;
			const display=translated?.display??core.display(item.requestId);
			if(display) control(device,{type:"question",requestId:item.requestId,display});
		}
	}
	function current(call:Joined) {return !closed&&active===call&&online.has(call.device)&&!call.question.signal.aborted}
	function closeVoice(voice:VoiceCall) {
		const pending=voice.close().catch(()=>{if(!closed) report("voice-close-unavailable")});
		closing.add(pending);void pending.finally(()=>closing.delete(pending));
	}
	function fail(call:Joined) {
		if(!current(call)) return;
		report("voice-unavailable",call.id);
		call.question.close();control(call.device,{type:"error",code:"voice-unavailable"});
	}
	async function join(device:string,id:string,captions=false,language=languages.selected(device)) {
		const entry=requests.get(id);
		if(entry?.audience.has(device)&&!core.voiceAvailable(id)) {control(device,{type:"error",code:"voice-unavailable"});return}
		const question=!active&&entry?.audience.has(device)?core.join(id):undefined;
		if(!entry||!question||!gateway) {control(device,{type:"error",code:"request-unavailable"});return}
		feedback?.recover(`call:${id}`);
		const call:Joined={device,id,question,streaming:false};active=call;state();
		question.signal.addEventListener("abort",()=>{
			if(active!==call) return;
			active=undefined;call.streaming=false;
			control(device,{type:"ended",requestId:id});
			if(call.voice) closeVoice(call.voice);
			state();
		},{once:true});
		try {
			const voice=await transports.voice({
				ctx:entry.ctx,call:question,language,
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
	gateway=await transports.gateway({...settings,
		onError(code,fatal){
			if(closed) return;
			if(fatal) helperAvailable=false;
			if(code==="relay_disconnected" && !relayHealth) legacyRelayInterrupted=true;
			report(code);state();
		},
		onRelay(connected){
			if(closed) return;
			relayHealth=true;
			relay=connected?"connected":"reconnecting";
			if(connected) feedback?.recover("mobile-outage");
			state();
		},
		onRouting(next){if(!closed){prefs=next;core.configure(next);settings.onRouting?.(next);state()}},
		onConnect(device){
			if(closed) return;
			legacyRelayInterrupted=false;
			devices.add(device);online.add(device);connections.set(device,Symbol());
			inbox(device);state();
		},
		onLoss(device){
			online.delete(device);connections.delete(device);details.delete(device);
			if(!closed && active?.device===device) {
				report("call-interrupted",active.id);
				active.question.close();
			}
			state();
		},
		onPcm(device,pcm){
			const call=active;
			if(call?.device===device&&current(call)&&call.streaming) {
				try {call.voice!.sendPcm(pcm)} catch {fail(call)}
			}
		},
		async onMessage(device,message){
			if(closed||!online.has(device)) return;
			if (message.type==="list" && isLanguage(message.language)) {
				const saving=languages.set(device,message.language);
				settings.onLanguage?.(message.language);
				void saving.catch(()=>{if(!closed) report("language-preference-unavailable")});
			}
			switch(message.type){
				case "list":if(message.details===true) details.add(device);else details.delete(device);inbox(device);break;
				case "form": {
					const id=message.requestId,entry=requests.get(id),connection=connections.get(device),language=languages.selected(device);
					const translated=entry?.audience.has(device)&&language?presentation(id,language):undefined;
					const value=translated?await translated.promise:undefined;
					if(connections.get(device)!==connection) break;
					const form=requests.get(id)===entry&&entry?.audience.has(device)?value?.form??core.form(id):null;
					control(device,{type:"form",requestId:id,form,...(language?{language}:{})});
					break;
				}
				case "answer": {
					const connection=connections.get(device);
					const result=requests.get(message.requestId)?.audience.has(device)
						? await core.answer(message.requestId,message.values,message.notes,languages.get(device),answerLabels(message.requestId,languages.get(device)))
						: {status:"stale" as const,message:"This request is no longer available."};
					if(!closed && result.status==="uncertain") report("answer-uncertain",message.requestId);
					// A delayed receipt belongs only to the authenticated connection that submitted.
					if(connections.get(device)===connection) control(device,{type:"answer",requestId:message.requestId,...result});
					else if(!closed && (result.status==="accepted" || result.status==="uncertain")) report("answer-receipt-unavailable",message.requestId);
					break;
				}
				case "silence":if(requests.get(message.requestId)?.audience.has(device)) core.silence(message.requestId);break;
				case "join":await join(device,message.requestId,message.captions===true,message.language);break;
				case "hangup":if(active?.device===device&&active.id===message.requestId) active.question.close();break;
				case "played":break;
			}
		},
	});
	try {for(const device of await gateway.devices()) devices.add(device)}
	catch {closed=true;await gateway.close();throw Error("paired-devices-unavailable")}
	for(const device of online) inbox(device);
	state();
	return {
		get ringing(){return prefs.away || prefs.delayMs!==null},
		offer(ask,ctx){
			if(closed||!devices.size||requests.has(ask.requestId)) return;
			requests.set(ask.requestId,{ctx,audience:new Set(devices),abort:new AbortController(),translations:new Map()});
			let session:string|undefined;
			try {
				const name=ctx.sessionManager.getSessionName?.();
				if(typeof name==="string"&&name.trim()&&!/[\u0000-\u001f\u007f/\\]|:\/\/|^[A-Za-z]:/.test(name)) session=name.trim();
			} catch {}
			if(!core.offer(ask,ctx,path.basename(ctx.cwd),session)) requests.delete(ask.requestId);
		},
		end:id=>core.end(id),
		async endCall(id) {
			const call=active;
			if(closed||!call||call.id!==id) return false;
			call.question.close();
			await Promise.all(closing);
			return true;
		},
		async configure(patch){if(closed) throw Error("runtime-closed");await gateway!.routing(patch)},
		pair:()=>gateway!.pair(),
		async close(){
			if(closed) return;
			closed=true;feedback?.cancel("mobile-outage");
			for(const entry of requests.values()) entry.abort.abort();
			connections.clear();core.close();online.clear();details.clear();requests.clear();devices.clear();
			await Promise.all(invalidations);await gateway!.close();await Promise.all(closing);
			await languages.flush().catch(()=>report("language-preference-unavailable"));
		},
	};
}
