import { describe, expect, test } from "bun:test";
import { fieldQuestions } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-coding-agent";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { createResponder } from "../src/collab/responder";

const html = `<form><input type="hidden" name="revision" value="v1"><fieldset><legend>Release channel</legend>
<label><input type="radio" name="channel" value="test" checked> Canary</label>
<label><input type="radio" name="channel" value="prod"> Stable</label></fieldset>
<label for="why">Reason</label><textarea id="why" name="why" required minlength="3">draft</textarea></form>`;
const values = { revision: "v1", channel: "prod", why: "ship it" };
const other = "Other (type your own)";
const next = "Next →";
const help = (action: string, extra = "") => `${formatKeyHints(["up", "down"])} navigate  ${formatKeyHint("enter")} ${action}  ${extra}${formatKeyHint("escape")} cancel`;
const radio = (reqId: number, title: string): CollabUiRequest => ({ reqId, title, kind: "select", selectionMarker: "radio", options: ["Canary", "Stable", other], initialIndex: 0, helpText: help("select") });
const editor = (reqId: number, title: string, prefill: string): CollabUiRequest => ({ reqId, title, kind: "editor", prefill });
function questions(source: string) {
	return [...fieldQuestions(parseHtmlForm(source)).values()];
}
function setup(source = html) {
	const writes: [number, string | undefined][] = [];
	const r = createResponder(async (id, value) => { writes.push([id, value]); return true; });
	const tagged = r.prepare("A", source);
	const titles = questions(tagged);
	return { r, writes, tagged, first: titles[0]!, second: titles[1]! };
}

describe("confirmed native form replies", () => {
	test("keeps the original fields, submits the radio's native row and then the exact text", async () => {
		const { r, writes, tagged, first, second } = setup();
		const parsed = parseHtmlForm(tagged);
		expect(first).toContain("Release channel");
		expect(second).toContain("Reason");
		expect(questions(html)).not.toContain(first);
		expect(questions(html)).not.toContain(second);
		expect(parsed.hidden).toEqual([["revision", "v1"]]);
		expect(parsed.fields[0]).toEqual(parseHtmlForm(html).fields[0]);
		r.accept(radio(1, first));
		const result = r.submitConfirmed("A", values);
		expect(writes).toEqual([[1, "Stable"]]);
		expect(await r.submitConfirmed("A", values)).toBe("stale");
		r.end(1);
		r.accept(editor(2, second, "draft"));
		expect(await result).toBe("accepted");
		expect(writes).toEqual([[1, "Stable"], [2, "ship it"]]);
	});

	test.each<Record<string, string>>([
		{ ...values, why: "  " }, { ...values, why: "ab" }, { ...values, revision: "v2" },
		{ channel: "prod", why: "ship it" }, { ...values, surprise: "x" },
	])("validates the entire native result before sending its first field", async bad => {
		const { r, writes, first } = setup();
		r.accept(radio(1, first));
		expect(await r.submitConfirmed("A", bad)).toBe("stale");
		expect(writes).toEqual([]);
	});

	test("checkbox state, Other editor, and Next match exact native progression", async () => {
		const form = `<form><p>Teams?</p><label><input type="checkbox" name="teams" value="ops" checked required>Operations</label>
		<label><input type="checkbox" name="teams" value="qa">Quality</label></form>`;
		const { first, r, writes } = setup(form);
		const checkbox = (reqId: number, checkedIndices: number[]): CollabUiRequest => ({reqId, title: first, kind:"select", selectionMarker: "checkbox", checkedIndices, markableCount: 3, options: ["Operations", "Quality", other, next], helpText: help("toggle", `${next} continue  `) });
		r.accept(checkbox(1, [0]));
		const result = r.submitConfirmed("A", {teams: ["qa", "Design"]});
		for (const request of [checkbox(2, []), checkbox(3, [1]), { kind: "editor", title: first, reqId: 4 } as const, checkbox(5, [1, 2])]) {
			await Promise.resolve();
			r.end(request.reqId - 1);
			r.accept(request);
		}
		expect(await result).toBe("accepted");
		expect(writes).toEqual([[1,"Operations"],[2,"Quality"],[3,other],[4,"Design"],[5,next]]);
	});

	test("untaggable ambiguous names leave original HTML byte-for-byte unchanged", async () => {
		const source = `<form><input name='who'><input name='who' value='different'></form>`;
		const { r, tagged, writes } = setup(source);
		expect(tagged).toBe(source);
		r.accept(editor(4,"who",""));
		expect(await r.submitConfirmed("A", {who:"test"})).toBe("stale");
		expect(writes).toEqual([]);
	});

	test("cancel/desktop completion midway cannot be replayed against a lookalike next Ask", async () => {
		const { r, writes, first, second } = setup();
		r.accept(radio(1, first));
		const result = r.submitConfirmed("A", values);
		r.end(1);
		r.clear();
		expect(await result).toBe("stale");
		const [newFirst, newSecond] = questions(r.prepare("B", html));
		expect(newFirst).not.toBe(first);
		expect(newSecond).not.toBe(second);
		r.accept(radio(2, newFirst!));
		expect(await r.submitConfirmed("A", values)).toBe("stale");
		r.end(2);
		expect(await r.submitConfirmed("B", values)).toBe("stale");
		expect(writes).toEqual([[1,"Stable"]]);
	});

	test("equal question text on different fields is tagged independently", () => {
		const { first, second } = setup(`<form><label>Comment<input name="a"></label><label>Comment<input name="b"></label></form>`);
		expect(first).toContain("Comment"); expect(second).toContain("Comment"); expect(first).not.toBe(second);
	});

	test.each(["unrelated", "approval", "options", "initialIndex", "helpText", "overlap", "ended", "editor"])("never writes to %s", async fault => {
		const { r, writes, first, second } = setup();
		const request = radio(7, first);
		if (request.kind !== "select") throw Error("fixture");
		if (fault === "approval") request.approval = true;
		if (fault === "options") request.options.reverse();
		if (fault === "initialIndex") request.initialIndex = 1;
		if (fault === "helpText") request.helpText = "approve";
		if (fault === "unrelated") request.title = "Release channel";
		r.accept(fault === "editor" ? editor(7, first, "draft") : request);
		if (fault === "overlap") r.accept(editor(8, second, "draft"));
		if (fault === "ended") { r.end(7); r.accept(request); }
		expect(await r.submitConfirmed("A", values)).toBe("stale");
		expect(writes).toEqual([]);
	});

	test("unexpected editor prefill cannot receive confirmed text", async () => {
		const { r, writes, first, second } = setup();
		r.accept(radio(1, first));
		const answer = r.submitConfirmed("A", values);
		r.end(1);
		r.accept(editor(2,second,"a different draft"));
		expect(await answer).toBe("stale");
		expect(writes).toEqual([[1,"Stable"]]);
	});

	test("a radio Other answer goes through its own editor, with no prefill", async () => {
		const { r, writes, first, second } = setup();
		expect(r.accept(radio(1, first))).toBe(true);
		const result = r.submitConfirmed("A", { ...values, channel: "nightly" });
		r.end(1);
		expect(r.accept({kind: "editor", reqId: 2, title: first})).toBe(false);
		await Promise.resolve();
		r.end(2);
		expect(r.accept(editor(3, second, "draft"))).toBe(false);
		expect(await result).toBe("accepted");
		expect(writes).toEqual([[1,other],[2,"nightly"],[3,"ship it"]]);
	});

	test("no queued write survives disconnect during a previous send", async () => {
		const inFlight = Promise.withResolvers<boolean>();
		const writes: number[] = [];
		const r = createResponder((id) => { writes.push(id); return inFlight.promise; });
		const [first, second] = questions(r.prepare("A", html));
		r.accept(radio(10, first!));
		const result = r.submitConfirmed("A", values);
		r.end(10);
		r.accept(editor(11, second!, "draft"));
		r.clear();
		inFlight.resolve(true);
		expect(await result).toBe("stale");
		expect(writes).toEqual([10]);
	});

	test("numeric constraints require canonical numeric values, not coerced strings", async () => {
		const { r, writes, first } = setup(`<form><input name="count" type="number" min="1" required></form>`);
		expect(r.accept(editor(1, first, ""))).toBe(true);
		expect(await r.submitConfirmed("A", {count:"2"})).toBe("stale");
		expect(await r.submitConfirmed("A", {count:0})).toBe("stale");
		expect(await r.submitConfirmed("A", {count:2})).toBe("accepted");
		expect(writes).toEqual([[1,"2"]]);
	});

	test("duplicate option labels stay disambiguated, disabled rows are never sent", async () => {
		const { r, writes, first } = setup(`<form><label>Mode<select name="mode">
		<option value="fast">Fast</option><option value="gone" disabled>Disabled</option>
		<option value="slow">Fast</option></select></label></form>`);
		expect(r.accept({ reqId: 1, kind: "select", title: first, options: ["Fast", "Fast (2)"],
			selectionMarker:"radio", initialIndex:0, helpText:help("select") })).toBe(true);
		expect(await r.submitConfirmed("A", {mode:"Fast"})).toBe("stale");
		expect(await r.submitConfirmed("A", {mode:"gone"})).toBe("stale");
		expect(await r.submitConfirmed("A", {mode:"slow"})).toBe("accepted");
		expect(writes).toEqual([[1,"Fast (2)"]]);
	});

	test("shared native labels which cannot carry distinct field tags are not rewritten", async () => {
		const source = `<form><label>Shared question<input name="a"><input name="b"></label></form>`;
		const { r, tagged, writes } = setup(source);
		expect(tagged).toBe(source);
		expect(r.accept(editor(1, "Shared question", ""))).toBe(false);
		expect(await r.submitConfirmed("A", { a: "one", b: "two" })).toBe("stale");
		expect(writes).toEqual([]);
	});
});
