import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { choiceValue, fieldError, fieldQuestions, isArrayChoice, textValue } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { type ChoiceField, type ChoiceOption, type FormField, type HtmlForm, parseHtmlForm, spansText, type TextField } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-coding-agent";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { SYMBOL_PRESET_NAMES } from "@oh-my-pi/pi-tui/theme/schema";
import { type Element, parseHTML, serializeNode } from "@oh-my-pi/pi-utils/dom";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";

export type FormValues = Record<string, string | number | boolean | string[]>;
const OTHER = "Other (type your own)";
const NEXT = "Next →";
type Choice = { kind: "choice"; field: ChoiceField; title: string; enabled: ChoiceOption[]; rows: string[]; checked: number[] };
type Field = Choice | { kind: "text"; field: TextField; title: string };
export interface PreparedForm {
	html: string;
	fields: Field[];
	hidden: Map<string, string>;
	parsed: HtmlForm;
}

/** Decorate only question text. Re-parse the result with the host's own parser; never rebuild a form from its fields. */
export function tagForm(source: string): PreparedForm | undefined {
	const original = parseHtmlForm(source);
	const { document } = parseHTML(source);
	const root = document.querySelector("form");
	if (!root || !isDeepStrictEqual(original, parseHtmlForm(serializeNode(document)))) return;
	const controls = new Map<string, Element>();
	for (const control of root.querySelectorAll("input, select, textarea")) {
		const name = control.getAttribute("name");
		if (name && !controls.has(name)) controls.set(name, control);
	}
	const labels = new Map<string, Element>();
	for (const label of root.querySelectorAll("label")) {
		const id = label.getAttribute("for");
		if (id && !labels.has(id)) labels.set(id, label);
	}
	const questions = fieldQuestions(original);
	const nonce = randomBytes(16).toString("base64url");
	const hidden = new Map(original.hidden);
	const names = new Set(hidden.keys());
	if (hidden.size !== original.hidden.length || [...names].some(name => name in Object.prototype)) return;
	const titles = new Map<FormField, string>();
	for (const [index, field] of original.fields.entries()) {
		if (!field.name) continue;
		if (names.has(field.name) || field.name in Object.prototype) return;
		names.add(field.name);
		if (field.kind === "choice") {
			if (!field.other && field.options.every(option => option.disabled)) {
				if (field.required) return;
				continue; // The host skips this field without asking or contributing a value.
			}
			if (new Set(field.options.map(o => o.value)).size !== field.options.length) return;
		}
		const question = questions.get(field);
		const control = controls.get(field.name);
		if (!control || !question) return;
		const suffix = ` [${nonce}:${index + 1}]`;
		const title = question + suffix;
		const wrapper = control.closest("label");
		if (field.kind === "choice" && !field.select) {
			// A group's label belongs to the option, never to the question.
			const anchor = wrapper ?? control;
			const caption = anchor.previousElementSibling;
			if (caption && /^(?:p|h[1-6]|legend)$/.test(caption.localName) && caption.textContent?.replace(/\s+/g, " ").trim() === question) {
				caption.append(suffix);
			} else {
				const caption = document.createElement("p");
				caption.textContent = title;
				anchor.parentNode?.insertBefore(caption, anchor);
			}
		} else {
			const label = wrapper ?? labels.get(control.id);
			if (label) label.append(suffix);
			else control.setAttribute("aria-label", title);
		}
		titles.set(field, title);
	}
	if (!titles.size) return;
	const html = serializeNode(document);
	const tagged = parseHtmlForm(html);
	if (original.fields.length !== tagged.fields.length || !isDeepStrictEqual(original.hidden, tagged.hidden)) return;
	const revised = fieldQuestions(tagged);
	const fields: Field[] = [];
	for (const [index, field] of original.fields.entries()) {
		const actual = tagged.fields[index]!;
		const title = titles.get(field);
		if (revised.get(actual) !== (title ?? questions.get(field))) return;
		// Changing a label is intentional; option labels, checked flags, values, constraints, order, etc. are not.
		if (!isDeepStrictEqual(field, title ? { ...actual, label: field.label } : actual)) return;
		if (!title) continue;
		if (field.kind === "text") fields.push({ kind: "text", field, title });
		else {
			const enabled = field.options.filter(option => !option.disabled);
			const taken = new Set([OTHER, NEXT]);
			// Native disambiguateDisplayLabels, without importing the terminal renderer/native addon.
			const rows = enabled.map(option => {
				const base = (spansText(option.label).trim() || option.value).replaceAll("\r\n", "\n").replace(/\r+/g, " ");
				let row = base;
				for (let n = 2; taken.has(row); n++) row = `${base} (${n})`;
				taken.add(row);
				return row;
			});
			if (field.other) rows.push(OTHER);
			fields.push({ kind: "choice", field, title, enabled, rows, checked: enabled.flatMap((o, i) => o.checked ? [i] : []) });
		}
	}
	return { html, fields, hidden, parsed: original };
}

// The extension may have its own copy of pi-tui rather than the host's active theme singleton.
// Accept entire, exact hint strings from stock glyph presets or the local active theme, not arbitrary prose.
const keys = SYMBOL_PRESET_NAMES.map(presetSymbols).map(s => [ `${s["key.up"]}/${s["key.down"]}`, s["key.enter"], s["key.esc"] ] as const);
function helpVariants(action: string, continuation: boolean): string[] {
	const active = [formatKeyHints(["up", "down"]), formatKeyHint("enter"), formatKeyHint("escape")];
	return [active, ...keys].map(([nav, enter, esc]) => `${nav} navigate  ${enter} ${action}  ${continuation ? `${NEXT} continue  ` : ""}${esc} cancel`);
}

type Expected = { draft: CollabUiRequestDraft; hints?: string[] };
export type Step = { expected: Expected; value: string };
function prompt(field: Field, checked?: Set<number>, other = false): Expected {
	const { title } = field;
	if (field.kind === "text") return { draft: { kind: "editor", title, prefill: field.field.value } };
	if (!field.field.multi) return { draft: { kind: "select", title, selectionMarker: "radio", options: field.rows, initialIndex: field.checked.at(-1) ?? 0 }, hints: helpVariants("select", false) };
	const indices = checked ? [...checked].sort((a, b) => a - b) : [...field.checked];
	if (other) indices.push(field.enabled.length);
	return { draft: { kind: "select", title, selectionMarker: "checkbox", checkedIndices: indices, markableCount: field.rows.length, options: [...field.rows, NEXT] }, hints: helpVariants("toggle", true) };
}

export function firstPrompt(form: PreparedForm): Expected {
	return prompt(form.fields[0]!);
}

export function matches(expected: Expected, draft: CollabUiRequestDraft): boolean {
	if (!expected.hints) return isDeepStrictEqual(draft, expected.draft);
	if (draft.kind !== "select") return false;
	const { helpText, ...rest } = draft;
	return typeof helpText === "string" && expected.hints.includes(helpText) && isDeepStrictEqual(rest, expected.draft);
}

type Answer = { kind: "text"; field: Extract<Field, {kind: "text"}>; text: string } | { kind: "choice"; field: Choice; target: Set<number>; other?: string };

/** Validate all canonical native values before dispatching even one step. A checkbox is its HTML value (or omitted), not a boolean. */
export function planAnswers(form: PreparedForm, values: FormValues): Generator<Step> | undefined {
	if (!values || typeof values !== "object" || Array.isArray(values)) return;
	const remaining = new Set(Object.keys(values));
	for (const [name, fixed] of form.hidden) {
		if (!remaining.delete(name) || values[name] !== fixed) return;
	}
	const answers: Answer[] = [];
	for (const field of form.fields) {
		const source = field.field;
		const supplied = remaining.delete(source.name);
		const value = supplied ? values[source.name] : undefined;
		if (supplied && value === undefined) return;
		if (field.kind === "text") {
			if (typeof value !== "string" && typeof value !== "number") return;
			const text = String(value);
			if ((!field.field.multiline && /[\r\n]/.test(text)) || !Object.is(textValue(field.field, text), value) || fieldError(field.field, value)) return;
			answers.push({ kind: "text", field, text });
			continue;
		}
		if (typeof value === "boolean" || typeof value === "number" || fieldError(field.field, value)) return;
		if (isArrayChoice(field.field) !== Array.isArray(value)) return;
		const selected = Array.isArray(value) ? value : value === undefined ? [] : [value];
		const target = new Set<number>();
		let other: string | undefined;
		for (const v of selected) {
			if (typeof v !== "string") return;
			const row = field.enabled.findIndex(option => option.value === v);
			if (row >= 0) target.add(row);
			else if (field.field.other && other === undefined && v && v.trim() === v && !/[\r\n]/.test(v) && !field.field.options.some(o => o.value === v)) other = v;
			else return;
		}
		if (!field.field.multi && !target.size && other === undefined) return; // A radio has no Skip row.
		const indices = new Set<number>();
		for (const row of target) indices.add(field.field.options.indexOf(field.enabled[row]!));
		if (!isDeepStrictEqual(choiceValue(field.field, indices, other), value)) return;
		answers.push({ kind: "choice", field, target, other });
	}
	if (remaining.size) return;
	return walk(answers);
}

/** Predict exactly the selector/editor sequence in the stock controller's runGuestForm. */
function* walk(answers: Answer[]): Generator<Step> {
	for (const answer of answers) {
		if (answer.kind === "text") {
			yield { expected: prompt(answer.field), value: answer.text };
			continue;
		}
		const { field, target, other } = answer;
		const checked = new Set(field.checked);
		if (field.field.multi) {
			for (let row = 0; row < field.enabled.length; row++) {
				if (checked.has(row) === target.has(row)) continue;
				yield { expected: prompt(field, checked), value: field.rows[row]! };
				if (!checked.delete(row)) checked.add(row);
			}
		} else if (other === undefined) {
			yield { expected: prompt(field), value: field.rows[[...target][0]!]! };
		}
		if (other !== undefined) {
			yield { expected: prompt(field, checked), value: OTHER };
			yield { expected: { draft: { kind: "editor", title: field.title } }, value: other };
		}
		if (field.field.multi) yield { expected: prompt(field, checked, other !== undefined), value: NEXT };
	}
}
