import { fieldContexts, fieldQuestions, formContext } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { type FormField, type HtmlForm, spansText } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";

/** Read-only presentation; positional IDs never authorize or encode a submission. */
export interface QuestionDisplay {
	v: 1;
	context: string;
	fields: Array<{
		id: string; label: string; kind: "single" | "multi" | "text"; required: boolean;
		description?: string; other?: boolean; inputType?: string; placeholder?: string;
		options?: Array<{ id: string; label: string; disabled: boolean }>;
	}>;
}
const text = (value: string) => value.length <= 8192 && !value.includes("\0") && value.isWellFormed();

/** UTF-16 bounds shared with Android, without emitting a dangling surrogate. */
export function displayExcerpt(value:string,limit:number) {
	return value.toWellFormed().replaceAll("\0","\uFFFD").slice(0,limit).replace(/[\uD800-\uDBFF]$/u,"");
}

/** Use the same parser output that native validation owns, never parse HTML again. */
export function questionDisplay(parsed: HtmlForm): QuestionDisplay | undefined {
	if (!parsed.fields.length || parsed.fields.length > 32) return;
	const questions = fieldQuestions(parsed), contexts = fieldContexts(parsed);
	const groups=new Map<FormField,string>();
	for (const section of parsed.sections) for (const block of section.blocks) {
		if (block.kind==="field") groups.set(block.field,spansText(section.title).trim());
	}
	const context = formContext(parsed).join("\n\n");
	if (!text(context)) return;
	const fields: QuestionDisplay["fields"] = [];
	for (const [index, field] of parsed.fields.entries()) {
		const question = questions.get(field);
		const label = question && question !== field.name ? question : `Question ${index + 1}`;
		const surrounding=contexts.get(field) ?? "", group=groups.get(field) ?? "";
		const descriptions = [group && !surrounding.split("\n\n").includes(group) ? group : "", surrounding];
		if (field.kind === "text") {
			if (field.min !== undefined) descriptions.push(`Minimum: ${field.min}`);
			if (field.max !== undefined) descriptions.push(`Maximum: ${field.max}`);
			if (field.minLength !== undefined) descriptions.push(`Minimum length: ${field.minLength}`);
			if (field.maxLength !== undefined) descriptions.push(`Maximum length: ${field.maxLength}`);
			if (field.pattern) descriptions.push(`Pattern: ${field.pattern}`);
		}
		const description = descriptions.filter(Boolean).join("\n\n");
		if (!text(label) || !text(description)) return;
		const common = { id: `f${index + 1}`, label, required: field.required, ...(description ? {description} : {}) };
		if (field.kind === "text") {
			if (!text(field.type) || !text(field.placeholder)) return;
			fields.push({...common, kind: "text", inputType: field.type, ...(field.placeholder ? {placeholder: field.placeholder} : {})});
		} else {
			if (field.options.length > 256) return;
			const options = field.options.map((option, i) => ({id: `o${i + 1}`, label: spansText(option.label).trim() || `Option ${i + 1}`, disabled: option.disabled}));
			if (!options.every(option => text(option.label))) return;
			fields.push({...common, kind: field.multi ? "multi" : "single", other: field.other, options});
		}
	}
	const display: QuestionDisplay = {v: 1, context, fields};
	return Buffer.byteLength(JSON.stringify(display)) <= 49_152 ? display : undefined;
}
