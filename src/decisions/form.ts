import { fieldQuestions, formContext, isArrayChoice } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import { type FormValues, planAnswers, tagForm, type PreparedForm } from "../collab/form";

export interface DecisionForm { native: PreparedForm; questions: Map<string,string>; description: string; question: string }
export interface Draft { values: FormValues; spoken: string }
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
	return {native,questions,description,question:fields.map(f=>f.question).join("; ").slice(0,256)};
}
const record = (x:unknown): x is Record<string,unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const key = (s:string) => s.toLowerCase().normalize("NFC").replace(/\s+/g," ").trim();
function mentioned(evidence:string, label:string) {
	const atom = key(label).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
	return !!atom && new RegExp(`(?:^|[^\\p{L}\\p{N}])${atom}(?:$|[^\\p{L}\\p{N}])`,"u").test(key(evidence));
}
/** A model proposes, never validates. Hidden fields stay local. Every editable field needs speech evidence. */
export function extractDraft(form: DecisionForm, utterance: string, json: string): Draft | undefined {
	let data:unknown;
	try { data=JSON.parse(json); } catch { return; }
	if (!record(data) || Object.keys(data).length !== 1 || !Array.isArray(data.fields) || data.fields.length !== form.native.fields.length) return;
	const rows = new Map<string,{value:unknown;evidence:string}>();
	for (const row of data.fields) {
		if (!record(row) || typeof row.name !== "string" || rows.has(row.name) || !Object.hasOwn(row,"value") || Object.keys(row).length !== 3 || typeof row.evidence !== "string" || !row.evidence.trim() || !utterance.includes(row.evidence)) return;
		rows.set(row.name,{value:row.value,evidence:row.evidence});
	}
	const values: FormValues = Object.fromEntries(form.native.hidden);
	const lines: string[] = [];
	for (const item of form.native.fields) {
		const {field} = item, row = rows.get(field.name);
		if (!row) return;
		const {value,evidence} = row;
		if (value !== null && typeof value !== "number" && typeof value !== "string" && !(Array.isArray(value) && value.every(v=>typeof v === "string"))) return;
		if (value !== null) values[field.name]=value;
		const pieces:string[]=[];
		if(item.kind === "choice") {
			for (const v of Array.isArray(value)?value:value===null?[]:[value]) {
				if(typeof v!=="string") return;
				const option=item.enabled.find(o=>o.value===v);
				const label = (option && spansText(option.label).trim()) || v;
				if (!mentioned(evidence,label) && !mentioned(evidence,v)) return;
				pieces.push(label === v ? JSON.stringify(v) : `${JSON.stringify(label)}, value ${JSON.stringify(v)}`);
			}
		} else {
			if(typeof value!=="string" && typeof value!=="number") return;
			if(typeof value==="string" && value && !evidence.includes(value)) return;
			pieces.push(value===""?"empty text":JSON.stringify(value));
		}
		lines.push(`${form.questions.get(field.name)} (${field.name}): ${pieces.length ? pieces.join("; ") : "none selected"}.`);
	}
	if (!planAnswers(form.native,values)) return;
	const spoken=lines.join(" ");
	if (!budget(spoken,3_000) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(spoken)) return;
	return {values,spoken};
}
