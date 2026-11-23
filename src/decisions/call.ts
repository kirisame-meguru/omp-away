import readbackInstruction from "../../prompts/readback.md" with { type: "text" };
import { isDeepStrictEqual } from "node:util";
import { type DecisionForm, type Draft, exactChoiceDraft, extractDraft, type SpokenDraft } from "./form";
import { type Exchange, side, type SideContext } from "./side";

export type DecisionReply = {kind:"say"; text:string; draft?:SpokenDraft} | {kind:"ignored"|"accepted"|"stale"};
export interface DecisionCall {
	readonly signal: AbortSignal;
	brief():Promise<string>;
	opening():string;
	consult(question:string):Promise<string>;
	speechStarted(utteranceId:string, startedAt?:number):void;
	speechFinished(utteranceId:string, transcript:string):Promise<DecisionReply>;
	interrupt():void;
	close():void;
}
interface CallOptions {
	form:DecisionForm; ctx:SideContext; history:Exchange[];
	close():void;
	submit(values: Draft["values"]):Promise<"accepted"|"stale">;
}
// Recognition may punctuate a rising affirmative or combine repeated replies into one turn.
// Every repeated clause must still be the same complete affirmative, never a qualifier.
const directYes=/^((?:yes|yeah|yep|yup|sure|ok(?:ay)?)(?:[,\s]+(?:please|(?:please\s+)?(?:submit(?:\s+it)?|go\s+ahead)))?|submit(?:\s+it)?|go\s+ahead|that['’]s\s+correct|that\s+is\s+correct)(?:[,\s.!?…]+\1)*[.!?…]*$/iu;
const repeat=/^(?:(?:please )?repeat (?:the |that |your )?(?:readback|answer)|(?:please )?say that again|(?:please )?repeat that)[.!?]?$/i;
const greeting=/^(?:(?:hello|hey|hi)(?: there)?[\s,.!?]*)+$/i;
const ignored:DecisionReply={kind:"ignored"}, stale:DecisionReply={kind:"stale"};
export function createCall(opt:CallOptions):DecisionCall {
	const life=new AbortController();
	const used=new Set<string>();
	let currentBrief="", submitting=false, proposal:Draft|undefined, confirmable:Draft|undefined;
	let confirmableAt=0;
	let speaking:{id:string;draft?:Draft}|undefined;
	let work:AbortController|undefined;
	function invalidate() {
		work?.abort(); work=undefined; confirmable=undefined; speaking=undefined;
	}
	function close() {
		if(life.signal.aborted) return;
		invalidate(); proposal=undefined; currentBrief=""; used.clear(); life.abort(); opt.close();
	}
	function takeId(id:string) {
		if(typeof id!=="string" || !id || id.length>256 || used.has(id)) return false;
		// Excessive traffic closes this call, not its underlying Ask.
		if(used.size>=2048) { close(); return false; }
		used.add(id); return true;
	}
	function read(draft:Draft):DecisionReply {
		confirmable=draft;confirmableAt=performance.now();
		return {kind:"say",text:`${readbackInstruction.trim()}\n${draft.voiceData}`,draft:draft.fields};
	}
	async function submit(draft:Draft):Promise<DecisionReply> {
		if(submitting || life.signal.aborted || proposal!==draft) return stale;
		submitting=true; invalidate(); proposal=undefined;
		try { return {kind:await opt.submit(draft.values)}; }
		catch { return stale; }
		finally { close(); }
	}
	async function consult(question:string) {
		if(!currentBrief || life.signal.aborted || submitting) throw Error("call-unavailable");
		invalidate();
		if(typeof question!=="string" || !question.trim() || Buffer.byteLength(question)>2048) throw Error("consult-unavailable");
		const [field]=opt.form.native.fields;
		if(opt.form.native.fields.length===1 && field.kind==="choice" &&
			/^what (?:are (?:the|my) (?:options|choices)|can I (?:choose|pick))[?!.]?$/i.test(question.trim())) {
			const menu=`The options are: ${field.rows.join("; ")}.`;
			if(menu.length<=8192) return menu;
		}
		const token=work=new AbortController();
		try {
			const answer=await side(opt.ctx,opt.form,"consult",{question,history:opt.history},token.signal);
			if(token.signal.aborted || life.signal.aborted) throw Error("call-ended");
			opt.history.push({question,answer}); if(opt.history.length>4) opt.history.shift();
			return answer;
		} finally { if(work===token) work=undefined; }
	}
	return {
		signal:life.signal,
		async brief() {
			if(life.signal.aborted) throw Error("call-ended");
			const brief=opt.form.question;
			currentBrief=opt.form.opening;
			return opt.form.description.length<=8192 ? opt.form.description : brief;
		},
		opening:()=>currentBrief,
		consult,
		interrupt:invalidate,
		speechStarted(id,startedAt=performance.now()) {
			if(life.signal.aborted || submitting) return;
			const previous=speaking, draft=confirmableAt<=startedAt ? confirmable : undefined;
			invalidate();
			if(!takeId(id) || previous || !currentBrief) return;
			speaking={id,draft};
		},
		async speechFinished(id,text) {
			if(life.signal.aborted || submitting) return stale;
			if(!speaking || speaking.id!==id) { invalidate(); return ignored; }
			const {draft}=speaking; speaking=undefined;
			if(typeof text!=="string" || !text.trim() || Buffer.byteLength(text)>4096) return ignored;
			const utterance=text.trim();
			// Only an explicit affirmative in a separate utterance submits.
			if(greeting.test(utterance)) return {kind:"say",text:currentBrief};
			if(directYes.test(utterance)) {
				return draft ? submit(draft) : ignored;
			}
			if(repeat.test(utterance)) return proposal ? read(proposal) : {kind:"say",text:currentBrief};
			if(/^(?:no|nope|cancel|stop|discard|never mind|do not submit|don't submit)[.!]?$/i.test(utterance)) { proposal=undefined; return ignored; }
			const exact=exactChoiceDraft(opt.form,utterance);
			if(exact) { proposal=exact; return read(exact); }
			const token=work=new AbortController();
			try {
				const previous=proposal;
				proposal=undefined;
				const json=await side(opt.ctx,opt.form,"extract",{utterance:text,...(previous ? {previousDraft:previous.fields} : {})},token.signal);
				if(token.signal.aborted || life.signal.aborted) return stale;
				const intent:unknown=JSON.parse(json);
				if(isDeepStrictEqual(intent,{repeat:true}) && previous) { proposal=previous; return read(previous); }
				if(isDeepStrictEqual(intent,{clarify:true})) {
					proposal=previous;
					return {kind:"say",text:await consult(text)};
				}
				proposal=extractDraft(opt.form,text,intent,previous);
				return proposal ? read(proposal) : {kind:"say",text:currentBrief};
			} catch { return token.signal.aborted || life.signal.aborted ? stale : {kind:"say",text:"The coding session could not interpret that answer. Nothing was submitted."}; }
			finally { if(work===token) work=undefined; }
		},
		close,
	};
}
