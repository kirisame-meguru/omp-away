import { isDeepStrictEqual } from "node:util";
import { fieldQuestions, formContext, isArrayChoice } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import { type FormValues, planAnswers, tagForm, type PreparedForm } from "../collab/form";

export interface DecisionForm { native: PreparedForm; questions:Map<string,string>; description: string; question: string }
export type SpokenDraft=ReadonlyArray<{readonly field:string; readonly answer:string | readonly string[] | null}>;
export interface Draft { values: FormValues; fields: SpokenDraft; voiceData: string }
const budget = (text: string, bytes: number) => Buffer.byteLength(text) <= bytes;
export function prepare(html: string): DecisionForm | undefined {
	if (!budget(html,65_536)) return;
	const native = tagForm(html);
	if (!native || native.fields.length > 32) return;
	const parsed = parseHtmlForm(html);
	const questions = new Map([...fieldQuestions(parsed)].map(([field,label])=>[field.name,label]));
	const fields = native.fields.map(item => {
		const {field} = item;
		const common = {name:field.name,question:questions.get(field.name),required:field.required};
		if (field.kind === "text") return {...common,type:field.type,min:field.min,max:field.max,minLength:field.minLength,maxLength:field.maxLength,pattern:field.pattern};
		return {...common,type:"choice",array:isArrayChoice(field),multiple:field.multi,other:field.other,options:field.options.filter(o=>!o.disabled).map(o=>({value:o.value,label:spansText(o.label).trim() || o.value}))};
	});
	const description = JSON.stringify({context:formContext(parsed),fields});
	if (!budget(description,16_384)) return;
	const names=new Map<string,number>();
	for(const f of fields) {const k=audible(f.question || f.name); names.set(k,(names.get(k)??0)+1);}
	for(const f of fields) if((names.get(audible(f.question || f.name)) ?? 0)>1) questions.set(f.name,`${f.question || f.name} (${f.name})`);
	return {native,questions,description,question:fields.map(f=>f.question).join("; ").slice(0,256)};
}
const record = (x:unknown): x is Record<string,unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const key = (s:string) => s.toLowerCase().normalize("NFC").replace(/\s+/g," ").trim();
const audible=(s:string)=>key(s).match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
function mentioned(evidence:string, label:string) {
	const atom = key(label).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
	return !!atom && new RegExp(`(?:^|[^\\p{L}\\p{N}])${atom}(?:$|[^\\p{L}\\p{N}])`,"u").test(key(evidence));
}

/** An entire, unambiguous native option label needs no semantic inference. */
export function exactChoiceDraft(form: DecisionForm, utterance: string): Draft | undefined {
	if (form.native.fields.length!==1 || /[\r\n?]/u.test(utterance)) return;
	const [item]=form.native.fields;
	if (item.kind!=="choice" || item.field.multi || isArrayChoice(item.field)) return;
	const answer=key(utterance.replace(/[.!]+$/u,""));
	let value:string|undefined;
	for (const option of item.enabled) {
		if (key(spansText(option.label).trim() || option.value)!==answer) continue;
		if (value!==undefined) return;
		value=option.value;
	}
	if (value===undefined) return;
	return extractDraft(form,utterance,{fields:[{name:item.field.name,value,evidence:utterance}]});
}

/** A model proposes, never validates. Hidden fields stay local. Every editable field needs speech evidence. */
export function extractDraft(form: DecisionForm, utterance: string, data:unknown, previous?:Draft): Draft | undefined {
	if (!record(data) || Object.keys(data).length!==1) return;
	const patch=previous!==undefined && Object.hasOwn(data,"changes");
	const input=patch ? data.changes : data.fields;
	if(!Array.isArray(input) || !input.length || input.length>form.native.fields.length || (!patch && input.length!==form.native.fields.length)) return;
	const rows = new Map<string,{value:unknown;evidence:string}>();
	for (const row of input) {
		if (!record(row) || typeof row.name !== "string" || rows.has(row.name) || !Object.hasOwn(row,"value") || Object.keys(row).length !== 3 || typeof row.evidence !== "string" || !row.evidence.trim() || !utterance.includes(row.evidence)) return;
		rows.set(row.name,{value:row.value,evidence:row.evidence});
	}
	const values: FormValues = Object.fromEntries(form.native.hidden);
	const fields:Array<SpokenDraft[number]>=[];
	for (const [index,item] of form.native.fields.entries()) {
		const {field} = item, row = rows.get(field.name);
		if (!row) {
			if(!patch || !previous) return;
			if(Object.hasOwn(previous.values,field.name)) values[field.name]=previous.values[field.name]!;
			fields.push(previous.fields[index]!);
			continue;
		}
		rows.delete(field.name);
		const title=form.questions.get(field.name) || field.name;
		const {value,evidence} = row;
		if (value !== null && typeof value !== "number" && typeof value !== "string" && !(Array.isArray(value) && value.every(v=>typeof v === "string"))) return;
		if (value !== null) values[field.name]=Array.isArray(value) ? Object.freeze(value) as string[] : value;
		const pieces:string[]=[];
		let answer:SpokenDraft[number]["answer"];
		if(item.kind === "choice") {
			for (const v of Array.isArray(value)?value:value===null?[]:[value]) {
				if(typeof v!=="string") return;
				const option=item.enabled.find(o=>o.value===v);
				const label = (option && spansText(option.label).trim()) || v;
				if (!(option ? mentioned(evidence,label) || mentioned(evidence,v) : evidence.includes(v))) return;
				// Reject audibly indistinguishable options; a codebook is not a voice decision.
				if(option && item.enabled.some(o=>o!==option && audible(spansText(o.label).trim() || o.value)===audible(label))) return;
				pieces.push(label);
			}
			answer=Array.isArray(value) ? Object.freeze(pieces) : pieces[0] ?? null;
		} else {
			if(typeof value!=="string" && typeof value!=="number") return;
			if(typeof value==="string" && value && !evidence.includes(value)) return;
			answer=String(value);
		}
		fields.push(Object.freeze({field:title,answer}));
	}
	if (rows.size || !planAnswers(form.native,values)) return;
	const voiceData=JSON.stringify({fields});
	if(!budget(voiceData,4096)) return;
	return {values:Object.freeze(values),fields:Object.freeze(fields),voiceData};
}

const prose=/^\p{L}+(?: \p{L}+)+[.!]?$/u;
const sentence=(s:string)=>s[0]!.toLowerCase()+s.slice(1).replace(/[.!]$/u,"");
/** Compare reconstructed fields, not delivery wording. Only plain prose has sentence-level ASR variation. */
export function matchesReadback(form:DecisionForm, expected:FormValues, heard:FormValues):boolean {
	// Both objects have passed planAnswers against this same form, including immutable hidden values.
	for(const {field} of form.native.fields) {
		const a=expected[field.name], b=heard[field.name];
		if(isDeepStrictEqual(a,b)) continue;
		if(field.kind!=="text" || (field.type!=="text" && field.type!=="textarea") || typeof a!=="string" || typeof b!=="string" ||
			!prose.test(a) || !prose.test(b) || sentence(a)!==sentence(b)) return false;
	}
	return true;
}
