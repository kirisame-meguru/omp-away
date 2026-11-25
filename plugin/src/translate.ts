import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { FormBlock, FormField, FormSpan } from "@oh-my-pi/pi-tui/html-form/parse";
import type { QuestionDisplay } from "./decisions/display";
import type { TouchForm } from "./decisions/touch";
import type { Language } from "./language";
import prompt from "./prompts/translate.md" with { type: "text" };

export interface Presentation {
  title: string;
  form: TouchForm | null;
  display: QuestionDisplay | undefined;
}

const maxBytes = 60_000;
const maxStringLength = 8192;

/** Translate a detached presentation only; native fields and submission values are never model output. */
export async function translatePresentation(
  ctx: Pick<ExtensionContext, "runEphemeralTurn">,
  language: Language,
  input: Presentation,
  signal: AbortSignal,
): Promise<Presentation> {
  signal.throwIfAborted();
  if (typeof ctx.runEphemeralTurn !== "function") throw Error("translation-unavailable");
  if (Buffer.byteLength(JSON.stringify(input)) > maxBytes) throw Error("translation-input-too-large");
  const result = structuredClone(input);
  const entries: Array<{ text: string; apply(text: string): void }> = [];
  const protectedText = new Set<string>();
  function collect(value: string, apply: (text: string) => void): void {
    if (!value.isWellFormed() || value.includes("\0") || value.length > maxStringLength)
      throw Error("translation-input-invalid");
    // Whitespace carries span boundaries, not language.
    if (value.trim()) entries.push({ text: value, apply });
  }
  function spans(items: FormSpan[]): void {
    for (const item of items) {
      if (item.style === "code") {
        if (item.text) protectedText.add(item.text);
      } else collect(item.text, text => { item.text = text; });
    }
  }
  function block(item: FormBlock): void {
    switch (item.kind) {
      case "text": spans(item.spans); break;
      case "list": for (const row of item.items) spans(row); break;
      case "table": for (const row of item.rows) for (const cell of row) spans(cell); break;
      case "pre": if (item.text) protectedText.add(item.text); break;
      case "image":
      case "svg": collect(item.alt, text => { item.alt = text; }); break;
      case "field": {
        const field: FormField & { question?: string } = item.field;
        spans(field.label);
        if (typeof field.question === "string" && field.question !== field.name)
          collect(field.question, text => { field.question = text; });
        if (field.kind === "choice") {
          for (const option of field.options) spans(option.label);
        } else {
          collect(field.placeholder, text => { field.placeholder = text; });
          if (field.pattern) protectedText.add(field.pattern);
        }
        break;
      }
    }
  }
  collect(result.title, text => { result.title = text; });
  if (result.form) {
    const form = result.form;
    if (form.title !== undefined) collect(form.title, text => { form.title = text; });
    if (form.description !== undefined) collect(form.description, text => { form.description = text; });
    for (const section of form.sections) {
      spans(section.title);
      for (const item of section.blocks) block(item);
    }
  }
  if (result.display) {
    const display = result.display;
    collect(display.context, text => { display.context = text; });
    for (const field of display.fields) {
      collect(field.label, text => { field.label = text; });
      if (field.description !== undefined) collect(field.description, text => { field.description = text; });
      if (field.placeholder !== undefined) collect(field.placeholder, text => { field.placeholder = text; });
      for (const option of field.options ?? []) collect(option.label, text => { option.label = text; });
    }
  }
  if (!entries.length) return result;

  // Flattened question labels/context can repeat structured code or patterns.
  // Protect those literals before inference, then restore their original bytes.
  const literals = [...protectedText].sort((a, b) => b.length - a.length);
  let prefix = "__AWAY_KEEP_";
  while (entries.some(entry => entry.text.includes(prefix)) || literals.some(text => text.includes(prefix))) prefix += "_";
  let nextToken = 0;
  const batches = entries.map(entry => {
    const tokens: Array<{ token: string; literal: string }> = [];
    let offset = 0;
    let text = "";
    while (offset < entry.text.length) {
      let position = entry.text.length;
      let match: string | undefined;
      for (const literal of literals) {
        const found = entry.text.indexOf(literal, offset);
        if (found >= 0 && found < position) { position = found; match = literal; }
      }
      text += entry.text.slice(offset, position);
      if (match === undefined) break;
      const token = `${prefix}${nextToken++}__`;
      tokens.push({ token, literal: match });
      text += token;
      offset = position + match.length;
    }
    return { text, tokens };
  });
  const promptText = `${prompt}\n${JSON.stringify({ language: language === "ru" ? "Russian" : "English", strings: batches.map(batch => batch.text) })}`;
  if (Buffer.byteLength(promptText) > maxBytes) throw Error("translation-input-too-large");
  const reply = await ctx.runEphemeralTurn({
    promptText,
    tools: false,
    dedupeReply: false,
    purpose: "away-translation",
    signal,
    replyMaxBytes: maxBytes,
    minimizeEffort: true,
  });
  signal.throwIfAborted();
  if (typeof reply?.replyText !== "string" || Buffer.byteLength(reply.replyText) > maxBytes)
    throw Error("translation-reply-invalid");
  let translated: unknown;
  try { translated = JSON.parse(reply.replyText); }
  catch { throw Error("translation-reply-invalid"); }
  if (!Array.isArray(translated) || translated.length !== entries.length) throw Error("translation-reply-invalid");
  for (let index = 0; index < entries.length; index++) {
    const value: unknown = translated[index];
    if (typeof value !== "string" || !value.trim() || !value.isWellFormed() || value.includes("\0"))
      throw Error("translation-reply-invalid");
    let text = value;
    let previous = -1;
    for (const { token, literal } of batches[index].tokens) {
      const position = text.indexOf(token);
      if (position < previous || position < 0 || text.indexOf(token, position + token.length) >= 0)
        throw Error("translation-reply-invalid");
      previous = position + literal.length;
      text = text.slice(0, position) + literal + text.slice(position + token.length);
    }
    if (text.includes(prefix) || text.length > maxStringLength || !text.isWellFormed() || text.includes("\0"))
      throw Error("translation-reply-invalid");
    entries[index].apply(text);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes ||
      result.display && Buffer.byteLength(JSON.stringify(result.display)) > 49_152)
    throw Error("translation-output-too-large");
  return result;
}
