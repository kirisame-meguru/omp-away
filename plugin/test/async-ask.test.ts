import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { PendingAsk } from "../src";
import { connectAsyncQuestions, type AsyncQuestion, type QuestionSource, type QuestionSubmission } from "../src/runtime/async-ask";

function fixture() {
	const events = new EventBus();
	const offered: PendingAsk[] = [], ended: string[] = [], errors: string[] = [];
	const ctx = { sessionManager: { getSessionId: () => "owner" } } as unknown as ExtensionContext;
	const admin = { offer(ask: PendingAsk) { offered.push(ask); }, end(id: string) { ended.push(id); } };
	const connection = connectAsyncQuestions(events, "owner", admin, ctx, code => errors.push(code));
	return { events, offered, ended, errors, connection };
}
function source() {
	const life = new AbortController();
	let listener: ((questions: readonly AsyncQuestion[]) => void) | undefined;
	let submissions = 0;
	const question: AsyncQuestion = {
		id: "canonical", requestId: crypto.randomUUID(), toolCallId: "tool", title: "Deploy", blockedWork: "Deployment", createdAt: 1000,
		html: '<form><label>Target<input name="target" required></label></form>',
		submitConfirmed() { submissions++; return { kind: "accepted", answerId: "answer", delivery: "queued" }; },
	};
	const value: QuestionSource = {
		version: 1, sessionId: "owner", signal: life.signal,
		subscribe(next) { listener = next; next([question]); return () => { listener = undefined; }; },
	};
	return { life, question, value, publish: (questions: readonly AsyncQuestion[]) => listener?.(questions), submissions: () => submissions };
}
function serve(events: EventBus, value: QuestionSource) {
	return events.on("omp-async-ask:connect:v1", request => {
		const connect = request as { sessionId: string; accept(source: QuestionSource): void };
		if (connect.sessionId === value.sessionId) connect.accept(value);
	});
}

test("late discovery forwards pending questions once and withdrawal revokes retained confirmation", async () => {
	const f = fixture(), s = source(), off = serve(f.events, s.value);
	try {
		f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
		f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
		s.publish([s.question]);
		expect(f.offered).toHaveLength(1);
		const cap = f.offered[0]!;
		expect(cap.createdAt).toBe(1000);
		expect(cap.requestId).not.toBe(s.question.id);
		s.publish([]);
		expect(f.ended).toEqual([cap.requestId]);
		expect(await cap.submitConfirmed(cap.requestId, { target: "old" })).toBe("stale");
		expect(s.submissions()).toBe(0);
	} finally { f.connection.close(); off(); }
});

test("a restored owner with the same canonical IDs receives fresh capabilities while old ones stay stale", async () => {
	const f = fixture(), old = source();
	let current = old.value;
	const off = f.events.on("omp-async-ask:connect:v1", request => {
		if (request && typeof request === "object" && "accept" in request && typeof request.accept === "function") request.accept(current);
	});
	try {
		f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
		const cap = f.offered[0]!;
		old.life.abort();
		const fresh = source(); current = fresh.value;
		f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
		const next = f.offered[1]!;
		expect(next.deduplicationKey).not.toBe(cap.deduplicationKey);
		expect(await cap.submitConfirmed(cap.requestId, { target: "old" })).toBe("stale");
		expect(await next.submitConfirmed(next.requestId, { target: "new" })).toBe("accepted");
		expect(old.submissions()).toBe(0); expect(fresh.submissions()).toBe(1);
	} finally { f.connection.close(); off(); }
});

test("synchronous canonical retirement during a phone submission does not replace its receipt with stale", async () => {
	const f = fixture(), s = source(), off = serve(f.events, s.value);
	s.question.submitConfirmed = () => { s.publish([]); return { kind: "accepted", answerId: "own", delivery: "recorded" }; };
	try {
		f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
		const cap = f.offered[0]!;
		expect(await cap.submitConfirmed(cap.requestId, { target: "staging" })).toBe("accepted");
		expect(f.ended).toEqual([cap.requestId]);
		expect(await cap.submitConfirmed(cap.requestId, { target: "again" })).toBe("stale");
	} finally { f.connection.close(); off(); }
});

test("saved, invalid and uncertain outcomes retire the mobile attempt without automatic retry", async () => {
	const outcomes: QuestionSubmission[] = [{ kind: "saved", answerId: "saved", delivery: "failed" }, { kind: "invalid" }, { kind: "uncertain" }];
	for (const result of outcomes) {
		const f = fixture(), s = source(), off = serve(f.events, s.value);
		let attempts = 0;
		s.question.submitConfirmed = () => { attempts++; return result; };
		try {
			f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
			const cap = f.offered[0]!;
			expect(await cap.submitConfirmed(cap.requestId, { target: "staging" })).toBe("stale");
			s.publish([s.question]);
			expect(f.offered).toHaveLength(1);
			expect(f.ended).toEqual([cap.requestId]);
			expect(await cap.submitConfirmed(cap.requestId, { target: "again" })).toBe("stale");
			expect(attempts).toBe(1);
			expect(f.errors).toEqual([`async-answer-${result.kind}`]);
		} finally { f.connection.close(); off(); }
	}
});

test("malformed snapshots fail closed instead of partially offering questions", () => {
	const f = fixture(), s = source(), off = serve(f.events, s.value);
	try {
		f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
		s.publish([s.question, { ...s.question, id: "malformed", createdAt: NaN }]);
		expect(f.offered).toHaveLength(1);
		expect(f.ended).toEqual([f.offered[0]!.requestId]);
		expect(f.errors).toEqual(["async-source-invalid", "async-forwarding-unavailable"]);
	} finally { f.connection.close(); off(); }
});

test("source abort inside initial subscription cannot leave an orphaned subscription or mobile offer", () => {
	const f = fixture(), s = source();
	let detached = 0;
	s.value.subscribe = listener => { listener([s.question]); s.life.abort(); return () => { detached++; }; };
	const off = serve(f.events, s.value);
	try {
		f.events.emit("omp-async-ask:available:v1", { version: 1, sessionId: "owner" });
		expect(f.ended).toEqual([f.offered[0]!.requestId]);
		expect(detached).toBe(1);
	} finally { f.connection.close(); off(); }
});
