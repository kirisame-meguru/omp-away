import type { PendingAsk } from "../index";
import { type DecisionForm, prepare } from "./form";
import { preferences, type Preferences } from "./preferences";
import { displayExcerpt } from "./display";
import { touchForm, touchValues, touchNotes, type TouchForm, type TouchResult } from "./touch";

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
	error?(code:string, requestId?:string):void;
	preferences?:Preferences;
	clock?:Clock;
}
interface Entry {
	item:InboxItem; ask:PendingAsk; form:DecisionForm;
	cancelTimer?:()=>void; silenced:boolean; rang:boolean; withdrawing:boolean; submitted:boolean;
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
		if(!form) {this.#opt.error?.("unsupported-form",ask.requestId);return false}
		const item:InboxItem={requestId:ask.requestId,project:displayExcerpt(project,128),question:form.question,createdAt,...(session?{session:displayExcerpt(session,128)}:{})};
		const entry:Entry={item,ask,form,silenced:false,rang:false,withdrawing:false,submitted:false};
		this.#pending.set(ask.requestId,entry);this.#route(entry);this.#opt.changed?.();return true;
	}
	#route(e:Entry) {
		e.cancelTimer?.();e.cancelTimer=undefined;
		if(e.rang||e.silenced||e.withdrawing||e.submitted) return;
		const {away,delayMs}=this.#prefs;
		if(!away&&delayMs===null) return;
		const ring=()=>{
			e.cancelTimer=undefined;
			if(this.#closed||this.#pending.get(e.item.requestId)!==e||e.rang||e.silenced||e.withdrawing||e.submitted) return;
			e.rang=true;
			const failed=()=>{if(this.#pending.get(e.item.requestId)===e&&!e.silenced) this.#opt.error?.("invite-unavailable",e.item.requestId)};
			try {Promise.resolve(this.#opt.invite(e.item.requestId)).catch(failed)} catch {failed()}
		};
		const wait=away?0:Math.max(0,e.item.createdAt+delayMs!-this.#clock.now());
		if(wait===0) ring();else e.cancelTimer=this.#clock.after(wait,ring);
	}
	list():InboxItem[] {return Array.from(this.#pending.values(),e=>({...e.item}))}
	get pendingCount():number {return this.#pending.size}
	expectsMobile():boolean {
		if(this.#closed) return false;
		const {away,delayMs}=this.#prefs;
		for(const entry of this.#pending.values()) {
			if(!entry.silenced&&!entry.submitted&&!entry.withdrawing &&
				(away || delayMs!==null && this.#clock.now()>=entry.item.createdAt+delayMs)) return true;
		}
		return false;
	}
	form(id:string):TouchForm|null {
		const entry=this.#pending.get(id);
		if(!entry||entry.submitted||entry.withdrawing||this.#closed) return null;
		const form={...touchForm(entry.ask.html,entry.form),optionNotes:entry.ask.supportsOptionNotes===true,
			title:entry.ask.context?.title,description:entry.ask.context?.blockedWork,voice:this.voiceAvailable(id)};
		return Buffer.byteLength(JSON.stringify(form))<=60_000 ? form : null;
	}
	async answer(id:string,input:unknown,noteInput:unknown=[]):Promise<TouchResult> {
		const entry=this.#pending.get(id);
		if(!entry||entry.submitted||this.#closed) return {status:"stale",message:"This request is no longer available."};
		if(entry.withdrawing||this.#active?.entry===entry) return {status:"busy",message:"End the voice interaction before submitting by touch."};
		const checked=touchValues(entry.form,input);
		if("error" in checked) return {status:"invalid",message:checked.error};
		const notes=touchNotes(entry.form,checked.values,noteInput);
		if(!notes||notes.length&&!entry.ask.supportsOptionNotes) return {status:"invalid",message:"Option notes are invalid or unsupported by this desktop."};
		// Reserve before dispatch; removal from the inbox cannot revoke this attempt's receipt.
		entry.submitted=true;
		this.silence(id);
		try {
			if(await entry.ask.submitConfirmed(id,checked.values,notes)==="accepted") {
				if(this.#pending.get(id)===entry) this.end(id);
				return {status:"accepted",message:"Answer submitted."};
			}
		} catch { /* A partially dispatched answer must never be retried automatically. */ }
		return {status:"uncertain",message:"Submission could not be confirmed. Check the desktop before answering again."};
	}
	display(id:string) {return this.#pending.get(id)?.form.display}
	// Native live owns its context budget; legacy scripted-readback limits do not apply.
	voiceAvailable(id:string) {const entry=this.#pending.get(id);return !!entry&&!entry.submitted&&!entry.withdrawing}
	silence(id:string):boolean {
		const e=this.#pending.get(id);if(!e) return false;
		e.silenced=true;e.cancelTimer?.();e.cancelTimer=undefined;return true;
	}
	join(id:string):QuestionCall|undefined {
		const entry=this.#pending.get(id);
		if(this.#closed||this.#active||!entry||entry.withdrawing||entry.submitted) return;
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
