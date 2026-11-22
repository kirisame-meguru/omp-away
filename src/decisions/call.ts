import { randomInt, randomUUID } from "node:crypto";
import { type DecisionForm, type Draft, extractDraft } from "./form";
import { type Exchange, side, type SideContext, untilAbort } from "./side";

export type DecisionReply = {kind:"say"; text:string; mark?:string; confirmationPhrase?:string} | {kind:"ignored"|"accepted"|"stale"};
export interface DecisionCall {
	readonly signal: AbortSignal;
	brief():Promise<string>;
	consult(question:string):Promise<string>;
	speechStarted(utteranceId:string):void;
	speechFinished(utteranceId:string, transcript:string):Promise<DecisionReply>;
	interrupt():void;
	provisionalConfirmation(mark:string,utteranceId:string,transcript:string):boolean;
	played(mark:string):Promise<DecisionReply>;
	close():void;
}
interface CallOptions {
	form:DecisionForm; ctx:SideContext; history:Exchange[];
	brief():Promise<string>; close():void;
	submit(values: Draft["values"]):Promise<"accepted"|"stale">;
}
const words=("acorn amber anchor apple arbor arrow atlas autumn badge bamboo barrel beacon berry birch bison blossom boat bottle branch breeze brick brook brush bucket cabin cactus candle canyon carpet castle cedar cello cherry circle clay cliff clover coast cobalt comet coral cotton crane creek cricket crown crystal daisy delta denim desert dolphin drum eagle earth elm ember emerald falcon feather fern field finch flame flint flower flute forest frost garden garnet gecko ginger glacier globe grape gravel grove harbor hazel heron hickory honey horn island ivory jade jasmine juniper kettle kite lake lantern larch lemon lilac lily linen lion lotus maple marble meadow melon mint mirror moss nectar ocean olive onyx orchid otter peach pearl pebble pepper petal pine plum pond poplar poppy prism quartz raven reed reef robin rocket rose ruby saddle sage salmon satin scarlet shell shore silver slate snow solar spark spruce spring stone storm summit swift thistle thorn tiger timber tulip turtle velvet violet walnut wave wheat willow winter wolf wren zinc").split(" ");
function challenge():string {
	const selected=new Set<string>();
	while(selected.size<4) selected.add(words[randomInt(words.length)]!);
	return [...selected].join(" ");
}
interface Readback {mark:string; phrase:string; draft:Draft; phase:"waiting"|"played"|"provisional"}
function matchesAffirmative(text:string, phrase:string) {
	return text.trim().toLowerCase().replace(/[.!]$/u,"").replace(/^yes,\s+/u,"yes ").replace(/^yes submit,\s+/u,"yes submit ").replace(/\s+/gu," ")===phrase;
}
const ignored:DecisionReply={kind:"ignored"}, stale:DecisionReply={kind:"stale"};
export function createCall(opt:CallOptions):DecisionCall {
	const life=new AbortController();
	const used=new Set<string>();
	const issuedTails=new Set<string>();
	let briefReady=false, submitting=false, proposal:Draft|undefined, reading:Readback|undefined;
	let speaking:{id:string;armed?:Readback}|undefined;
	let work:AbortController|undefined;
	function invalidate() {
		work?.abort(); work=undefined; reading=undefined; speaking=undefined;
	}
	function close() {
		if(life.signal.aborted) return;
		invalidate(); proposal=undefined; briefReady=false; used.clear(); issuedTails.clear(); life.abort(); opt.close();
	}
	function takeId(id:string) {
		if(typeof id!=="string" || !id || id.length>256 || used.has(id)) return false;
		// Excessive traffic closes this call, not its underlying Ask.
		if(used.size>=2048) { close(); return false; }
		used.add(id); return true;
	}
	function read(draft:Draft):DecisionReply {
		let tail:string;
		do { tail=challenge(); } while(issuedTails.has(tail) || draft.spoken.toLowerCase().includes(tail));
		issuedTails.add(tail);
		const mark=randomUUID(), phrase=`yes submit ${tail}`;
		reading={mark,phrase,draft,phase:"waiting"};
		return {kind:"say",text:`${draft.spoken} Your words are ${tail}.`,mark,confirmationPhrase:phrase};
	}
	async function submit(r:Readback):Promise<DecisionReply> {
		if(submitting || life.signal.aborted || proposal!==r.draft) return stale;
		submitting=true; invalidate(); proposal=undefined;
		try { return {kind:await opt.submit(r.draft.values)}; }
		catch { return stale; }
		finally { close(); }
	}
	return {
		signal:life.signal,
		async brief() {
			if(life.signal.aborted) throw Error("call-ended");
			const brief=await untilAbort(opt.brief,life.signal);
			if(life.signal.aborted) throw Error("call-ended");
			briefReady=true;
			return brief + " To propose an answer, say My answer is, then your choice for every field. Listen to the entire readback. To confirm, say yes submit followed by the four words at the end. To hear it again, say Repeat the readback.";
		},
		async consult(question) {
			if(!briefReady || life.signal.aborted || submitting) throw Error("call-unavailable");
			invalidate();
			if(typeof question!=="string" || !question.trim() || Buffer.byteLength(question)>2048) throw Error("consult-unavailable");
			const token=work=new AbortController();
			try {
				const answer=await side(opt.ctx,opt.form,"consult",{question,history:opt.history},token.signal);
				if(token.signal.aborted || life.signal.aborted) throw Error("call-ended");
				opt.history.push({question,answer}); if(opt.history.length>4) opt.history.shift();
				return answer;
			} finally { if(work===token) work=undefined; }
		},
		interrupt:invalidate,
		speechStarted(id) {
			if(life.signal.aborted || submitting) return;
			const previous=speaking, armed=reading?.phase==="played" ? reading : undefined;
			invalidate();
			if(!takeId(id) || previous || !briefReady) return;
			speaking={id,armed};
		},
		async speechFinished(id,text) {
			if(life.signal.aborted || submitting) return stale;
			if(!speaking || speaking.id!==id) { invalidate(); return ignored; }
			const {armed}=speaking; speaking=undefined;
			if(typeof text!=="string" || !text.trim() || Buffer.byteLength(text)>4096) return ignored;
			if(armed && matchesAffirmative(text,armed.phrase)) return submit(armed);
			if(/^repeat (?:the )?readback[.!]?$/i.test(text.trim()) && proposal) return read(proposal);
			if(/^(?:no|cancel|stop|discard)\b/i.test(text.trim())) { proposal=undefined; return ignored; }
			if(!/^(?:my answer is|i choose)\b[\s,:]+\S/i.test(text.trim())) return ignored;
			proposal=undefined;
			const token=work=new AbortController();
			try {
				const json=await side(opt.ctx,opt.form,"extract",{utterance:text},token.signal);
				if(token.signal.aborted || life.signal.aborted) return stale;
				proposal=extractDraft(opt.form,text,json);
				return proposal ? read(proposal) : {kind:"say",text:"I do not have a valid, complete answer. Please name each field and its choice explicitly."};
			} catch { return token.signal.aborted || life.signal.aborted ? stale : {kind:"say",text:"The coding session could not interpret that answer. Nothing was submitted."}; }
			finally { if(work===token) work=undefined; }
		},
		provisionalConfirmation(mark,id,text) {
			if(life.signal.aborted || submitting || !reading || reading.mark!==mark || reading.phase!=="waiting") return false;
			if(speaking || !takeId(id) || typeof text!=="string" || text.length>256 || !matchesAffirmative(text,reading.phrase)) { invalidate(); return false; }
			reading.phase="provisional"; return true;
		},
		async played(mark) {
			if(life.signal.aborted || submitting) return stale;
			if(!reading || reading.mark!==mark || speaking) return ignored;
			if(reading.phase==="provisional") return submit(reading);
			reading.phase="played"; return ignored;
		},
		close,
	};
}
