import { fieldQuestions, formContext, isArrayChoice } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import { type FormValues, planAnswers, tagForm, type PreparedForm } from "../collab/form";

export interface DecisionForm { native: PreparedForm; speech: Map<string,{title:string; labels:Map<string,string>}>; description: string; question: string }
export interface Draft { values: FormValues; spoken: string }
const budget = (text: string, bytes: number) => Buffer.byteLength(text) <= bytes;
const alphabet="alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");
const digits="zero one two three four five six seven eight nine".split(" ");
const punctuation:Record<string,string>={" ":"space","-":"dash","_":"underscore",".":"period",",":"comma",":":"colon","!":"exclamation","?":"question","/":"slash","\\":"backslash","\n":"newline","\r":"return","\t":"tab","'":"apostrophe",'"':"quote","@":"at","+":"plus","=":"equals"};
const numericPunctuation:Record<string,string>={"-":"minus","+":"plus",".":"point","e":"exponent"};
const reserved=/\b(?:also|field|value|other|none|spelled|your|words)\b/i;
/** Self-delimiting even after punctuation and capitalization are removed from ASR. */
function spell(text:string):string {
	if(!text) return "empty";
	const tokens:string[]=[];
	for(const ch of text) {
		const n=ch.codePointAt(0)!;
		if(n>=97 && n<=122) tokens.push(alphabet[n-97]!);
		else if(n>=65 && n<=90) tokens.push("capital",alphabet[n-65]!);
		else if(n>=48 && n<=57) tokens.push(digits[n-48]!);
		else if(punctuation[ch]) tokens.push(punctuation[ch]);
		else tokens.push("unicode",...String(n).split("").map(v=>digits[Number(v)]!),"end");
	}
	return tokens.join(" ");
}
// Reserve the grammar, including the acoustic tail, across every user-controlled label.
// Punctuation-only differences must not make a label unique under the media matcher.
function uniqueLabels(labels:string[]):Map<string,string> {
	const counts=new Map<string,number>();
	const keys=labels.map(s=>s.toLowerCase().match(/[a-z]+/g)?.join(" ") ?? "");
	for(const k of keys) counts.set(k,(counts.get(k)??0)+1);
	const usable=new Map<string,string>();
	for(const [i,label] of labels.entries()) {
		if(counts.get(keys[i]!)===1 && /^[A-Za-z]{2,}(?: [A-Za-z]{2,})*$/.test(label)
			&& !/\b[A-Z]{2,}\b/.test(label) && !reserved.test(label)) usable.set(label,label);
	}
	return usable;
}
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
	const titleLabels=uniqueLabels(fields.map(f=>f.question ?? ""));
	const speech:DecisionForm["speech"]=new Map();
	for(const f of fields) {
		const title=titleLabels.get(f.question ?? "") ?? `name spelled ${spell(f.name)}`;
		const labels=new Map<string,string>();
		if("options" in f && f.options) {
			const usable=uniqueLabels(f.options.map(o=>o.label));
			for(const o of f.options) if(usable.has(o.label)) labels.set(o.value,o.label);
		}
		speech.set(f.name,{title,labels});
	}
	return {native,speech,description,question:fields.map(f=>f.question).join("; ").slice(0,256)};
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
		const {title,labels}=form.speech.get(field.name)!;
		const {value,evidence} = row;
		if (value !== null && typeof value !== "number" && typeof value !== "string" && !(Array.isArray(value) && value.every(v=>typeof v === "string"))) return;
		if (value !== null) values[field.name]=value;
		const pieces:string[]=[];
		if(item.kind === "choice") {
			for (const v of Array.isArray(value)?value:value===null?[]:[value]) {
				if(typeof v!=="string") return;
				const option=item.enabled.find(o=>o.value===v);
				const label = (option && spansText(option.label).trim()) || v;
				if (!(option ? mentioned(evidence,label) || mentioned(evidence,v) : evidence.includes(v))) return;
				pieces.push(labels.get(v) ?? `${option ? "value" : "other"} spelled ${spell(v)}`);
			}
		} else {
			if(typeof value!=="string" && typeof value!=="number") return;
			if(typeof value==="string" && value && !evidence.includes(value)) return;
			if(typeof value==="string") {
				// The text prefix denotes literal lowercase ASCII, one space between words.
				const literal=/^[a-z]+(?: [a-z]+)*$/.test(value) && !reserved.test(value);
				pieces.push(literal ? `text ${value}` : `spelled ${spell(value)}`);
			}
			else {
				if(!Number.isFinite(value) || Object.is(value,-0)) return;
				pieces.push([...String(value)].map(ch=>numericPunctuation[ch] ?? digits[Number(ch)]!).join(" "));
			}
		}
		// "Field" separates clauses and "also" separates answers when ASR omits punctuation.
		lines.push(`${lines.length ? "Field " : ""}${title}: ${pieces.length ? pieces.join(" also ") : "none selected"}.`);
	}
	if (!planAnswers(form.native,values)) return;
	const spoken=lines.join(" ");
	if (!budget(spoken,3_000)) return;
	return {values,spoken};
}
