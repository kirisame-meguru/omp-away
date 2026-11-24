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
	readback(utteranceId:string, mark:string, transcript:string):Promise<boolean>;
	played(mark:string):void;
	outputStarted():void;
	interrupt():void;
	close():void;
}
interface CallOptions {
	form:DecisionForm; ctx:SideContext; history:Exchange[];
	close():void;
	submit(values: Draft["values"]):Promise<"accepted"|"stale">;
}
interface ReadbackProof {
	mark:string; draft:Draft; knownAt:number; playedAt?:number;
	controller:AbortController; result:Promise<boolean>;
}
// Recognition may punctuate a rising affirmative or combine repeated replies into one turn.
// Every repeated clause must still be the same complete affirmative, never a qualifier.
const directYes=/^((?:yes|yeah|yep|yup|sure|ok(?:ay)?)(?:[,\s]+(?:please|(?:please\s+)?(?:submit(?:\s+it)?|go\s+ahead)))?|submit(?:\s+it)?|go\s+ahead|that['’]s\s+correct|that\s+is\s+correct)(?:[,\s.!?…]+\1)*[.!?…]*$/iu;
const repeat=/^(?:(?:please )?repeat (?:the |that |your )?(?:readback|answer)|(?:please )?say that again|(?:please )?repeat that)[.!?]?$/i;
const greeting=/^(?:(?:hello|hey|hi)(?: there)?[\s,.!?]*)+$/i;
const ignored:DecisionReply={kind:"ignored"}, stale:DecisionReply={kind:"stale"};
export function createCall(opt:CallOptions):DecisionCall {
	const life=new AbortController();
	const used=new Map<string,boolean>(), marks=new Set<string>();
	let currentBrief="", submitting=false, proposal:Draft|undefined;
	let reviewOwner:string|undefined, proof:ReadbackProof|undefined;
	let speaking:{id:string;proof?:ReadbackProof}|undefined;
	let work:AbortController|undefined;
	function clearProof(keep?:ReadbackProof) {
		if(proof!==keep) proof?.controller.abort();
		proof=undefined;
	}
	function invalidate(keep?:ReadbackProof) {
		work?.abort(); work=undefined; clearProof(keep);
		if(speaking?.proof!==keep) speaking?.proof?.controller.abort();
		speaking=undefined; reviewOwner=undefined;
	}
	function close() {
		if(life.signal.aborted) return;
		invalidate(); proposal=undefined; currentBrief=""; used.clear(); marks.clear(); life.abort(); opt.close();
	}
	function takeId(id:string) {
		if(typeof id!=="string" || !id || id.length>256 || used.has(id)) return false;
		// Excessive traffic closes this call, not its underlying Ask.
		if(used.size>=2048) { close(); return false; }
		used.set(id,false); return true;
	}
	function read(draft:Draft, owner:string):DecisionReply {
		clearProof(); reviewOwner=owner;
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
		readback(owner,mark,transcript) {
			if(life.signal.aborted || submitting || !proposal || owner!==reviewOwner ||
				typeof mark!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(mark) || marks.has(mark))
				return Promise.resolve(false);
			if(marks.size>=2048) {close();return Promise.resolve(false);}
			marks.add(mark); clearProof();
			if(typeof transcript!=="string" || transcript.includes("\0") || Buffer.byteLength(transcript)>8192 ||
				!/\bsubmit\s*\?\s*$/iu.test(transcript) || (transcript.match(/\bsubmit\s*\?/giu)?.length??0)!==1)
				return Promise.resolve(false);
			const done=Promise.withResolvers<boolean>();
			const observed:ReadbackProof={mark,draft:proposal,knownAt:performance.now(),controller:new AbortController(),result:done.promise};
			// Publish before dispatch: a provider can synchronously reenter caller handling.
			proof=observed;
			void side(opt.ctx,opt.form,"verify",{transcript},observed.controller.signal).then(json=>{
				if(observed.controller.signal.aborted || life.signal.aborted || proposal!==observed.draft) return false;
				const spoken=extractDraft(opt.form,transcript,JSON.parse(json));
				return !!spoken && isDeepStrictEqual(spoken.values,observed.draft.values);
			}).then(done.resolve,()=>done.resolve(false));
			return done.promise;
		},
		played(mark) {
			if(!life.signal.aborted && proof?.mark===mark && proof.playedAt===undefined)
				proof.playedAt=performance.now();
		},
		outputStarted:()=>clearProof(),
		speechStarted(id,startedAt=performance.now()) {
			if(life.signal.aborted || submitting) return;
			const previous=speaking;
			const captured=!previous && Number.isFinite(startedAt) && proof && proof.knownAt<=startedAt &&
				proof.playedAt!==undefined && proof.playedAt<=startedAt ? proof : undefined;
			invalidate(captured);
			if(!takeId(id) || previous || !currentBrief) {captured?.controller.abort();return;}
			speaking={id,proof:captured};
		},
		async speechFinished(id,text) {
			if(life.signal.aborted || submitting) return stale;
			// A replayed final must not cancel verification already owned by this turn.
			if(used.get(id)===true) return ignored;
			if(!speaking || speaking.id!==id) { invalidate(); return ignored; }
			used.set(id,true);
			const captured=speaking.proof; speaking=undefined;
			if(typeof text!=="string" || !text.trim() || Buffer.byteLength(text)>4096) {
				captured?.controller.abort();return ignored;
			}
			const utterance=text.trim();
			// Before a proposal exists, literal options such as "Yes" and "No"
			// are answers. Once proposed, confirmation/cancellation takes precedence.
			if(!proposal) {
				const exact=exactChoiceDraft(opt.form,utterance);
				if(exact) { proposal=exact; return read(exact,id); }
			}
			// Only an explicit affirmative in a separate utterance submits.
			if(directYes.test(utterance)) {
				if(!captured) return proposal ? read(proposal,id) : ignored;
				const token=work=captured.controller;
				try {
					const verified=await captured.result;
					if(token.signal.aborted || life.signal.aborted || work!==token) return stale;
					return verified ? submit(captured.draft) : proposal ? read(proposal,id) : ignored;
				} finally {
					if(work===token) work=undefined;
					token.abort();
				}
			}
			captured?.controller.abort();
			if(greeting.test(utterance)) return {kind:"say",text:currentBrief};
			if(repeat.test(utterance)) return proposal ? read(proposal,id) : {kind:"say",text:currentBrief};
			if(/^(?:no|nope|cancel|stop|discard|never mind|do not submit|don't submit)[.!]?$/i.test(utterance)) { proposal=undefined; return ignored; }
			const exact=proposal ? exactChoiceDraft(opt.form,utterance) : undefined;
			if(exact) { proposal=exact; return read(exact,id); }
			const token=work=new AbortController();
			try {
				const previous=proposal;
				// Keep the validated draft until this classification settles; an interrupt
				// revokes confirmation but must not erase a draft awaiting discussion.
				const json=await side(opt.ctx,opt.form,"extract",{utterance:text,...(previous ? {previousDraft:previous.fields} : {})},token.signal);
				if(token.signal.aborted || life.signal.aborted) return stale;
				const intent:unknown=JSON.parse(json);
				if(isDeepStrictEqual(intent,{repeat:true}) && previous) return read(previous,id);
				if(isDeepStrictEqual(intent,{clarify:true})) {
					// The realtime voice already answers discussion from task context.
					return ignored;
				}
				proposal=extractDraft(opt.form,text,intent,previous);
				return proposal ? read(proposal,id) : ignored;
			} catch {
				if(token.signal.aborted || life.signal.aborted) return stale;
				proposal=undefined;
				return {kind:"say",text:"The coding session could not interpret that answer. Nothing was submitted."};
			}
			finally { if(work===token) work=undefined; }
		},
		close,
	};
}
