import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as registry from "@oh-my-pi/pi-coding-agent/config/registry";
import away, { type PendingAsk } from "../src";
import * as runtime from "../src/runtime";
import type { QuestionSource } from "../src/runtime/async-ask";

afterEach(() => mock.restore());

test("async offers work without native Collab, survive agent end and cannot outlive the Away session", async () => {
	spyOn(registry, "lookup").mockReturnValue(undefined);
	spyOn(runtime, "gatewayConfigured").mockReturnValue(true);
	const offered: PendingAsk[] = [], ended: string[] = [];
	let submitted = 0, closed = 0;
	spyOn(runtime, "openAdmin").mockResolvedValue({
		offer(ask) { offered.push(ask); }, end(id) { ended.push(id); },
		async close() { closed++; }, async command() {}, cancelEnrollment() {},
	});
	const events = new EventBus();
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler>();
	const ctx = {
		agent: { kind: "main" }, mode: "tui", isIdle: () => false,
		sessionManager: { getSessionId: () => "owner" }, ui: { notify() {} },
	} as unknown as ExtensionContext;
	const source: QuestionSource = {
		version: 1, sessionId: "owner", signal: new AbortController().signal,
		subscribe(listener) {
			listener([{
				id: "canonical", requestId: crypto.randomUUID(), toolCallId: "async-tool", title: "Choose target", blockedWork: "Deployment", createdAt: Date.now(),
				html: '<form><label>Target<input name="target" required></label></form>',
				submitConfirmed() { submitted++; return { kind: "accepted", answerId: "answer", delivery: "queued" }; },
			}]);
			return () => {};
		},
	};
	const off = events.on("omp-async-ask:connect:v1", request => {
		if (request && typeof request === "object" && "accept" in request && typeof request.accept === "function") request.accept(source);
	});
	const api = { events, registerCommand() {}, on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
	away(api);
	try {
		await handlers.get("session_start")!({}, ctx);
		expect(offered).toHaveLength(1);
		await handlers.get("agent_end")!({}, ctx);
		expect(ended).toEqual([]);
		await handlers.get("session_shutdown")!({}, ctx);
		expect(ended).toEqual([offered[0]!.requestId]);
		expect(closed).toBe(1);
		expect(await offered[0]!.submitConfirmed(offered[0]!.requestId, { target: "late" })).toBe("stale");
		expect(submitted).toBe(0);
	} finally { off(); await handlers.get("session_shutdown")!({}, ctx); }
});
