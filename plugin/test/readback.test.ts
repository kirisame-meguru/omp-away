import { expect, spyOn, test } from "bun:test";
import { createCall } from "../src/decisions/call";
import { prepare } from "../src/decisions/form";

test("draft issuance without readback/playback proof cannot authorize Yes", async () => {
	const form = prepare('<form><label for="drink">Drink</label><select id="drink" name="drink"><option value="tea">Tea</option><option value="coffee">Coffee</option></select></form>')!;
	const writes: unknown[] = [];
	const call = createCall({
		form, history: [], close() {},
		ctx: { async runEphemeralTurn() { throw Error("Literal choice needs no extraction"); } },
		async submit(values) { writes.push(values); return "accepted"; },
	});
	try {
		await call.brief();
		call.speechStarted("selection");
		expect((await call.speechFinished("selection", "Coffee")).kind).toBe("say");
		call.speechStarted("confirmation");
		await call.speechFinished("confirmation", "Yes");
		expect(writes).toEqual([]);
	} finally { call.close(); }
});

function fixture() {
	const form = prepare('<form><input type="hidden" name="rev" value="r4"><label for="drink">Drink</label><select id="drink" name="drink"><option value="tea">Tea</option><option value="coffee">Coffee</option></select></form>')!;
	const writes: unknown[] = [], verified: string[] = [];
	let reply: (signal: AbortSignal) => string | Promise<string> = () => JSON.stringify({
		fields: [{name: "drink", value: "coffee", evidence: "Coffee"}],
	});
	const call = createCall({
		form, history: [], close() {},
		ctx: {async runEphemeralTurn(options) {
			expect(options.purpose).toBe("away-verify");
			expect(options.tools).toBe(false);
			const input = JSON.parse(options.promptText.slice(options.promptText.lastIndexOf("\n") + 1));
			expect(Object.keys(input)).toEqual(["transcript"]);
			verified.push(input.transcript);
			return {replyText: await reply(options.signal), assistantMessage: {stopReason: "stop"}};
		}},
		async submit(values) { writes.push(values); return "accepted"; },
	});
	return {
		call, writes, verified,
		setReply(next: typeof reply) { reply = next; },
		async choose() {
			await call.brief();
			call.speechStarted("selection");
			expect((await call.speechFinished("selection", "Coffee")).kind).toBe("say");
		},
		async confirm(text = "Yes") {
			call.speechStarted("confirmation");
			return call.speechFinished("confirmation", text);
		},
	};
}

test("matching readback and played proof permit exactly one separate confirmation", async () => {
	const f = fixture();
	try {
		await f.choose();
		expect(await f.call.readback("selection", "response-1", "Drink: Coffee. Submit?")).toBe(true);
		f.call.played("response-1");
		expect(f.writes).toEqual([]);
		expect((await f.confirm()).kind).toBe("accepted");
		await f.call.speechFinished("confirmation", "Yes");
		expect(f.writes).toEqual([{rev: "r4", drink: "coffee"}]);
		expect(f.verified).toEqual(["Drink: Coffee. Submit?"]);
	} finally { f.call.close(); }
});

test.each(["missing", "unknown", "late"])
("a %s playback acknowledgment cannot authorize confirmation", async mode => {
	const f = fixture();
	try {
		await f.choose();
		expect(await f.call.readback("selection", "response-1", "Coffee. Submit?")).toBe(true);
		if (mode === "unknown") f.call.played("different-response");
		f.call.speechStarted("confirmation");
		if (mode === "late") f.call.played("response-1");
		await f.call.speechFinished("confirmation", "Yes");
		expect(f.writes).toEqual([]);
	} finally { f.call.close(); }
});

test("a physical onset predating played proof cannot use its later receipt", async () => {
	const f = fixture(), clock = spyOn(performance, "now").mockReturnValue(1000);
	try {
		await f.choose();
		await f.call.readback("selection", "response-1", "Coffee. Submit?");
		const began = 2000;
		clock.mockReturnValue(3000);
		f.call.played("response-1");
		f.call.speechStarted("confirmation", began);
		await f.call.speechFinished("confirmation", "Yes");
		expect(f.writes).toEqual([]);
	} finally { f.call.close(); clock.mockRestore(); }
});

test("verification may finish for immutable evidence captured before confirmation onset", async () => {
	const f = fixture(), result = Promise.withResolvers<string>();
	try {
		await f.choose();
		f.setReply(() => result.promise);
		const verification = f.call.readback("selection", "response-1", "Coffee. Submit?");
		f.call.played("response-1");
		const confirmation = f.confirm();
		expect(f.writes).toEqual([]);
		result.resolve('{"fields":[{"name":"drink","value":"coffee","evidence":"Coffee"}]}');
		expect(await verification).toBe(true);
		expect((await confirmation).kind).toBe("accepted");
		expect(f.writes).toEqual([{rev: "r4", drink: "coffee"}]);
	} finally { f.call.close(); }
});

test("a newer utterance cancels a confirmation awaiting verification", async () => {
	const f = fixture(), result = Promise.withResolvers<string>();
	try {
		await f.choose();
		f.setReply(() => result.promise);
		const verification = f.call.readback("selection", "response-1", "Coffee. Submit?");
		f.call.played("response-1");
		const confirmation = f.confirm();
		f.call.speechStarted("cancel");
		await f.call.speechFinished("cancel", "Cancel");
		result.resolve('{"fields":[{"name":"drink","value":"coffee","evidence":"Coffee"}]}');
		expect(await verification).toBe(false);
		expect((await confirmation).kind).toBe("stale");
		expect(f.writes).toEqual([]);
	} finally { f.call.close(); }
});

test.each([
	'{"fields":[{"name":"drink","value":"tea","evidence":"Tea"}]}',
	'{"fields":[]}',
	'{"fields":[{"name":"drink","value":"coffee","evidence":"invented evidence"}]}',
	'{"matches":true}',
	'{"unverifiable":true}',
	'not JSON',
])("unmatched or invalid readback evidence cannot authorize: %s", async reply => {
	const f = fixture();
	try {
		await f.choose();
		f.setReply(() => reply);
		expect(await f.call.readback("selection", "response-1", "Tea and Coffee. Submit?")).toBe(false);
		f.call.played("response-1");
		await f.confirm();
		expect(f.writes).toEqual([]);
	} finally { f.call.close(); }
});

test.each(["Coffee.", "Coffee. Submit? Coffee. Submit?", "Coffee. Submit? Maybe later."])
("incomplete or repeated Submit prompts cannot become proof: %s", async transcript => {
	const f = fixture();
	try {
		await f.choose();
		expect(await f.call.readback("selection", "response-1", transcript)).toBe(false);
		f.call.played("response-1");
		await f.confirm();
		expect(f.writes).toEqual([]);
		expect(f.verified).toEqual([]);
	} finally { f.call.close(); }
});

test("obsolete caller ownership and reused response IDs cannot acquire a new draft", async () => {
	const f = fixture();
	try {
		await f.choose();
		expect(await f.call.readback("older-selection", "wrong-owner", "Coffee. Submit?")).toBe(false);
		expect(await f.call.readback("selection", "response-1", "Coffee. Submit?")).toBe(true);
		f.call.played("response-1");
		f.call.speechStarted("repeat");
		await f.call.speechFinished("repeat", "Repeat that");
		expect(await f.call.readback("repeat", "response-1", "Coffee. Submit?")).toBe(false);
		f.call.played("response-1");
		await f.confirm();
		expect(f.writes).toEqual([]);
	} finally { f.call.close(); }
});

test("new assistant output revokes uncaptured eligibility", async () => {
	const f = fixture();
	try {
		await f.choose();
		await f.call.readback("selection", "response-1", "Coffee. Submit?");
		f.call.played("response-1");
		f.call.outputStarted();
		await f.confirm();
		expect(f.writes).toEqual([]);
	} finally { f.call.close(); }
});

test("later assistant output cannot change already captured confirmation evidence", async () => {
	const f = fixture();
	try {
		await f.choose();
		await f.call.readback("selection", "response-1", "Coffee. Submit?");
		f.call.played("response-1");
		f.call.speechStarted("confirmation");
		f.call.outputStarted();
		expect((await f.call.speechFinished("confirmation", "Yes")).kind).toBe("accepted");
		expect(f.writes).toEqual([{rev: "r4", drink: "coffee"}]);
	} finally { f.call.close(); }
});

test("interruption and failed verification never submit", async () => {
	const f = fixture();
	try {
		await f.choose();
		f.setReply(() => { throw Error("Provider unavailable"); });
		expect(await f.call.readback("selection", "response-1", "Coffee. Submit?")).toBe(false);
		f.call.played("response-1");
		f.call.interrupt();
		await f.confirm();
		expect(f.writes).toEqual([]);
	} finally { f.call.close(); }
});

test("a duplicate final cannot cancel an in-flight confirmation of captured proof", async () => {
	const f = fixture();
	try {
		await f.choose();
		await f.call.readback("selection", "response-1", "Coffee. Submit?");
		f.call.played("response-1");
		const confirmation = f.confirm();
		expect((await f.call.speechFinished("confirmation", "Yes")).kind).not.toBe("accepted");
		expect((await confirmation).kind).toBe("accepted");
		expect(f.writes).toEqual([{rev: "r4", drink: "coffee"}]);
	} finally { f.call.close(); }
});
