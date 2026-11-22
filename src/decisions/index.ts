import type { PendingAsk } from "../index";
import { createCall, type DecisionCall } from "./call";
import { type DecisionForm, prepare } from "./form";
import { preferences, type Preferences } from "./preferences";
import { type Exchange, side, type SideContext } from "./side";

export type { DecisionCall, DecisionReply } from "./call";
export type { SpokenDraft } from "./form";
export type { Preferences } from "./preferences";
export { loadPreferences, savePreferences } from "./preferences";
export type { SideContext } from "./side";

export interface InboxItem { requestId:string; project:string; question:string; createdAt:number }
export interface Clock { now():number; after(ms:number, callback:()=>void):()=>void }
interface Options {
	invite(requestId:string):void | Promise<void>;
	changed?():void;
	error?(code:string):void;
	preferences?:Preferences;
	clock?:Clock;
}
interface Entry {
	item:InboxItem; ask:PendingAsk; ctx:SideContext; form:DecisionForm; history:Exchange[];
	life:AbortController; brief:Promise<string|undefined>; cancelTimer?:()=>void;
	silenced:boolean; rang:boolean; submitted:boolean;
}
const realtime:Clock={ now:Date.now,after(ms,fn){const timer=setTimeout(fn,ms); return ()=>clearTimeout(timer);} };

/** Session-generation authority. Runtime authenticates and authorizes each peer per request (see API.md). */
export class DecisionCoordinator {
	readonly #pending=new Map<string,Entry>();
	readonly #seen=new Set<string>();
	readonly #tools=new Set<string>();
	readonly #opt:Options;
	readonly #clock:Clock;
	#prefs:Preferences;
	#active?:{entry:Entry;call:DecisionCall};
	#closed=false;
	constructor(opt:Options) {
		this.#opt=opt; this.#clock=opt.clock ?? realtime;
		this.#prefs=preferences(opt.preferences ?? {away:false,delayMs:null});
	}
	configure(data:Preferences) {
		this.#prefs=preferences(data);
		for(const entry of this.#pending.values()) this.#route(entry);
	}
	offer(ask:PendingAsk,ctx:SideContext,project:string):boolean {
		if(this.#closed || this.#seen.has(ask.requestId) || this.#tools.has(ask.toolCallId)) return false;
		this.#seen.add(ask.requestId); this.#tools.add(ask.toolCallId);
		let form:DecisionForm|undefined;
		try { form=prepare(ask.html); } catch { /* An unsupported form must remain local. */ }
		if(!form) { this.#opt.error?.("unsupported-form"); return false; }
		const life=new AbortController();
		const item={requestId:ask.requestId,project:project.slice(0,128),question:form.question,createdAt:this.#clock.now()};
		// Publish the entry before invoking host hooks (which may synchronously retire it).
		const selfContained=form.native.fields.length===1 && form.native.fields[0].kind==="choice" && !!form.question.trim();
		const brief=selfContained ? Promise.resolve(form.question) : Promise.resolve().then(()=>side(ctx,form,"brief",{},life.signal)).catch(()=>{
			if(!life.signal.aborted) this.#opt.error?.("brief-unavailable");
			return undefined;
		});
		const entry:Entry={item,ask,ctx,form,history:[],life,brief,silenced:false,rang:false,submitted:false};
		this.#pending.set(ask.requestId,entry); this.#route(entry); this.#opt.changed?.(); return true;
	}
	#route(e:Entry) {
		e.cancelTimer?.(); e.cancelTimer=undefined;
		if(e.life.signal.aborted || e.rang || e.silenced || e.submitted) return;
		const {away,delayMs}=this.#prefs;
		if(!away && delayMs===null) return;
		const wait=away ? 0 : Math.max(0,e.item.createdAt + delayMs! - this.#clock.now());
		const ring=()=>{
			e.cancelTimer=undefined;
			if(e.life.signal.aborted || e.rang || e.silenced || e.submitted) return;
			e.rang=true;
			const failed=()=>{if(!e.life.signal.aborted) this.#opt.error?.("invite-unavailable");};
			try { Promise.resolve(this.#opt.invite(e.item.requestId)).catch(failed); } catch { failed(); }
		};
		if(wait===0) ring(); else e.cancelTimer=this.#clock.after(wait,ring);
	}
	list():InboxItem[] { return Array.from(this.#pending.values(),e=>({...e.item})); }
	silence(id:string):boolean {
		const e=this.#pending.get(id); if(!e) return false;
		e.silenced=true; e.cancelTimer?.(); e.cancelTimer=undefined; return true;
	}
	join(id:string):DecisionCall|undefined {
		const entry=this.#pending.get(id);
		if(this.#active || !entry || entry.submitted || this.#closed) return;
		this.silence(id);
		const call=createCall({form:entry.form,ctx:entry.ctx,history:entry.history,
			brief:async()=>{const brief=await entry.brief; if(!brief) throw Error("brief-unavailable"); return brief;},
			close:()=>{if(this.#active?.call===call) this.#active=undefined;},
			submit:async values=>{
				if(this.#active?.call!==call || this.#pending.get(id)!==entry || entry.submitted) return "stale";
				// Before the first await: never retry partially dispatched Collab answers.
				entry.submitted=true;
				const result=await entry.ask.submitConfirmed(id,values);
				if(result==="accepted" && this.#pending.get(id)===entry) this.end(id);
				return result;
			},
		});
		this.#active={entry,call}; return call;
	}
	/** Call synchronously from every native finish/loss path, before resolving a native result or awaiting I/O. */
	end(id:string):void {
		if(this.#closed) return;
		this.#seen.add(id);
		const e=this.#pending.get(id); if(!e) return;
		this.#pending.delete(id); e.cancelTimer?.(); e.life.abort(); e.history.length=0;
		if(this.#active?.entry===e) this.#active.call.close();
		this.#opt.changed?.();
	}
	close():void {
		if(this.#closed) return;
		// Seal first: even synchronous listener re-entry cannot acquire a closing capability.
		this.#closed=true;
		for(const e of this.#pending.values()) {e.cancelTimer?.(); e.life.abort(); e.history.length=0;}
		this.#pending.clear(); this.#active?.call.close(); this.#seen.clear(); this.#tools.clear(); this.#opt.changed?.();
	}
}
