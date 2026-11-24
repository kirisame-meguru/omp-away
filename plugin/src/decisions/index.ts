import type { PendingAsk } from "../index";
import { type DecisionForm, prepare } from "./form";
import { preferences, type Preferences } from "./preferences";
import { displayExcerpt } from "./display";

export type { Preferences } from "./preferences";
export type { SideContext } from "./side";
export type { DecisionCall, DecisionReply } from "./call";
export type { SpokenDraft } from "./form";
export interface InboxItem { requestId:string; project:string; question:string; createdAt:number; session?:string }
export interface Clock { now():number; after(ms:number, callback:()=>void):()=>void }
export interface QuestionCall {
	signal:AbortSignal;
	question:PendingAsk;
	takeOver():Promise<void>;
	withdraw(reason:string):Promise<"accepted"|"stale">;
	close():void;
}
interface Options {
	invite(requestId:string):void|Promise<void>;
	changed?():void;
	retired?(requestId:string):void;
	error?(code:string):void;
	preferences?:Preferences;
	clock?:Clock;
}
interface Entry {
	item:InboxItem; ask:PendingAsk; form:DecisionForm;
	cancelTimer?:()=>void; silenced:boolean; rang:boolean; withdrawing:boolean;
}
const realtime:Clock={now:Date.now,after(ms,fn){const timer=setTimeout(fn,ms);return ()=>clearTimeout(timer)}};

export class DecisionCoordinator {
	readonly #pending=new Map<string,Entry>();
	readonly #seen=new Set<string>();
	readonly #tools=new Set<string>();
	readonly #opt:Options;
	readonly #clock:Clock;
	#prefs:Preferences;
	#active?:{entry:Entry;call:QuestionCall;takingOver:boolean;retired:boolean};
	#closed=false;
	constructor(opt:Options) {
		this.#opt=opt;this.#clock=opt.clock??realtime;
		this.#prefs=preferences(opt.preferences??{away:false,delayMs:null});
	}
	configure(data:Preferences) {
		this.#prefs=preferences(data);
		for(const entry of this.#pending.values()) this.#route(entry);
	}
	offer(ask:PendingAsk,_ctx:unknown,project:string,session?:string):boolean {
		const key=ask.deduplicationKey??ask.toolCallId,createdAt=ask.createdAt??this.#clock.now();
		if(this.#closed||this.#seen.has(ask.requestId)||this.#tools.has(key)||!Number.isSafeInteger(createdAt)||createdAt<0) return false;
		this.#seen.add(ask.requestId);this.#tools.add(key);
		let form:DecisionForm|undefined;
		try {form=prepare(ask.html,ask.context)} catch {}
		if(!form) {this.#opt.error?.("unsupported-form");return false}
		const item:InboxItem={requestId:ask.requestId,project:displayExcerpt(project,128),question:form.question,createdAt,...(session?{session:displayExcerpt(session,128)}:{})};
		const entry:Entry={item,ask,form,silenced:false,rang:false,withdrawing:false};
		this.#pending.set(ask.requestId,entry);this.#route(entry);this.#opt.changed?.();return true;
	}
	#route(e:Entry) {
		e.cancelTimer?.();e.cancelTimer=undefined;
		if(e.rang||e.silenced||e.withdrawing) return;
		const {away,delayMs}=this.#prefs;
		if(!away&&delayMs===null) return;
		const ring=()=>{
			e.cancelTimer=undefined;
			if(this.#closed||this.#pending.get(e.item.requestId)!==e||e.rang||e.silenced||e.withdrawing) return;
			e.rang=true;
			const failed=()=>{if(this.#pending.get(e.item.requestId)===e&&!e.silenced) this.#opt.error?.("invite-unavailable")};
			try {Promise.resolve(this.#opt.invite(e.item.requestId)).catch(failed)} catch {failed()}
		};
		const wait=away?0:Math.max(0,e.item.createdAt+delayMs!-this.#clock.now());
		if(wait===0) ring();else e.cancelTimer=this.#clock.after(wait,ring);
	}
	list():InboxItem[] {return Array.from(this.#pending.values(),e=>({...e.item}))}
	display(id:string) {return this.#pending.get(id)?.form.display}
	voiceAvailable(id:string) {return this.#pending.has(id)}
	silence(id:string):boolean {
		const e=this.#pending.get(id);if(!e) return false;
		e.silenced=true;e.cancelTimer?.();e.cancelTimer=undefined;return true;
	}
	join(id:string):QuestionCall|undefined {
		const entry=this.#pending.get(id);
		if(this.#closed||this.#active||!entry||entry.withdrawing) return;
		this.silence(id);
		const life=new AbortController();
		const call:QuestionCall={
			signal:life.signal,question:entry.ask,
			close:()=>{
				const active=this.#active;
				if(active?.call===call) this.#active=undefined;
				life.abort();
				if(active?.call===call&&active.retired) this.end(id);
			},
			takeOver:async()=>{
				if(!entry.ask.takeOver) return;
				const active=this.#active;
				if(active?.call!==call||active.takingOver||life.signal.aborted) throw Error("Question is no longer available");
				active.takingOver=true;
				try {
					if(await entry.ask.takeOver(id)!=="accepted"||life.signal.aborted) throw Error("Question takeover failed");
				} catch(error) {call.close();throw error}
			},
			withdraw:async reason=>{
				if(!entry.ask.withdraw||life.signal.aborted||this.#pending.get(id)!==entry||entry.withdrawing) return "stale";
				if(!reason.trim()||Buffer.byteLength(reason)>16384) throw Error("Invalid withdrawal reason");
				entry.withdrawing=true;
				const result=await entry.ask.withdraw!(id,reason);
				if(result==="accepted"&&this.#pending.get(id)===entry) this.end(id);
				return result;
			},
		};
		this.#active={entry,call,takingOver:false,retired:false};return call;
	}
	end(id:string):void {
		if(this.#closed) return;
		this.#seen.add(id);
		const entry=this.#pending.get(id);if(!entry) return;
		if(this.#active?.entry===entry&&this.#active.takingOver) {
			this.#active.retired=true;
			return;
		}
		this.#pending.delete(id);entry.cancelTimer?.();
		if(this.#active?.entry===entry) this.#active.call.close();
		this.#opt.retired?.(id);this.#opt.changed?.();
	}
	close():void {
		if(this.#closed) return;
		this.#closed=true;
		this.#active?.call.close();
		for(const e of this.#pending.values()) {e.cancelTimer?.();this.#opt.retired?.(e.item.requestId)}
		this.#pending.clear();this.#seen.clear();this.#tools.clear();this.#opt.changed?.();
	}
}
