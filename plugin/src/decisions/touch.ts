import { fieldError, fieldQuestions, isArrayChoice, textValue } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm, spansText, type FormSection } from "@oh-my-pi/pi-tui/html-form/parse";
import { planAnswers, type FormValues } from "../collab/form";
import type { DecisionForm } from "./form";
import type { AnswerNote } from "../index";
import type { Language } from "../language";
import { fieldValidationMessage, message } from "../messages";

export interface TouchForm { sections: FormSection[]; optionNotes?: boolean; title?: string; description?: string; voice?: boolean }
export function touchForm(html: string, form: DecisionForm): TouchForm {
	const parsed = parseHtmlForm(html);
	const questions = fieldQuestions(parsed);
	const editable = new Set(form.native.fields.map(item => item.field.name));
	return { sections: parsed.sections.map(section => ({ ...section, blocks: section.blocks.flatMap<FormSection["blocks"][number]>(block => {
		if (block.kind !== "field") return [block];
		if (!editable.has(block.field.name)) return [];
		const field = block.field;
		return [{ ...block, field: { ...field, question: questions.get(field), array: field.kind === "choice" && isArrayChoice(field) } }];
	}) })) };
}
export type TouchResult = { status: "accepted" | "invalid" | "stale" | "busy" | "uncertain"; message: string };

export function touchValues(form: DecisionForm, input: unknown, language: Language = "en", labels?: ReadonlyMap<string, string>): { values: FormValues } | { error: string } {
	if (!input || typeof input !== "object" || Array.isArray(input)) return { error: message(language, "Invalid answer.") };
	const supplied = input as Record<string, unknown>;
	const names = new Set(form.native.fields.map(item => item.field.name));
	if (Object.keys(supplied).some(name => !names.has(name))) return { error: message(language, "Unknown answer field.") };
	const values: FormValues = Object.fromEntries(form.native.hidden);
	for (const item of form.native.fields) {
		const field = item.field;
		let value = Object.hasOwn(supplied, field.name) ? supplied[field.name] : undefined;
		if (field.kind === "text" && typeof value === "string") value = textValue(field, value);
		if (value !== undefined && typeof value !== "string" && typeof value !== "number" && !(Array.isArray(value) && value.every(v => typeof v === "string"))) return { error: message(language, "Invalid answer value.") };
		const canonical = value as string | number | string[] | undefined;
		const error = fieldError(field, canonical);
		if (error) return { error: `${(labels?.get(field.name) ?? form.questions.get(field.name) ?? field.name).slice(0,4096)}: ${fieldValidationMessage(language, field, error)}` };
		if (canonical !== undefined) values[field.name] = canonical;
	}
	return planAnswers(form.native, values) ? { values } : { error: message(language, "Check your selections and text before submitting.") };
}

/** Derive labels locally; a handset may only attach notes to its selected answers. */
export function touchNotes(form: DecisionForm, values: FormValues, input: unknown): AnswerNote[] | undefined {
	if (!Array.isArray(input) || input.length > 128 || Buffer.byteLength(JSON.stringify(input)) > 24_000) return;
	const notes: AnswerNote[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
			Object.keys(raw).sort().join(",") !== "name,text,value" ||
			typeof raw.name !== "string" || typeof raw.value !== "string" || typeof raw.text !== "string" || !raw.text.trim()) return;
		const item = form.native.fields.find(item => item.field.name === raw.name);
		if (!item || item.kind !== "choice") return;
		const selected = values[raw.name];
		if (!(Array.isArray(selected) ? selected.includes(raw.value) : selected === raw.value)) return;
		const key = JSON.stringify([raw.name, raw.value]);
		if (seen.has(key)) return;
		seen.add(key);
		const option = item.enabled.find(option => option.value === raw.value);
		if (!option && !item.field.other) return;
		notes.push({name:raw.name,value:raw.value,text:raw.text,question:form.questions.get(raw.name) ?? raw.name,
			option:option ? spansText(option.label) || option.value : raw.value});
	}
	return notes;
}
