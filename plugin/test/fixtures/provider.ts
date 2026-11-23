import { appendFileSync, readFileSync, rmdirSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PendingAsk } from "../../src/index";

/** Test-only provider: models the assistant, not the Ask renderer, host or guest. */
export default function fixture(pi: ExtensionAPI) {
	const mail = process.env.OMP_AWAY_FIXTURE_MAIL;
	if (!mail || process.env.PI_CONFIG_DIR !== ".away-fixture" || resolve(mail) !== join(dirname(homedir()), "mail")) {
		throw new Error("Run the fixture with its isolated launcher");
	}
	const form = readFileSync(join(import.meta.dir, "form.html"), "utf8");
	const trace = (event: string, data = "") => appendFileSync(join(mail, "trace.ndjson"), JSON.stringify({ event, data }) + "\n");
	pi.registerProvider("away-fixture", {
		baseUrl: "http://127.0.0.1/unused", apiKey: "unused-test-key", api: "away-fixture-local",
		models: [{ id: "scripted", name: "Scripted Ask fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.findLast(m => m.role === "user" || m.role === "toolResult");
			const text = typeof last?.content === "string" ? last.content : last?.content.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
			const ask = last?.role === "user" && /\baway fixture\b/i.test(text) && context.tools?.some(t => t.name === "ask");
			const block = ask ? { type: "toolCall" as const, name: "ask", id: `fixture-${crypto.randomUUID()}`, arguments: { html: form } } :
				{ type: "text" as const, text: last?.role === "toolResult" && last.toolName === "ask" ? "Fixture received the native Ask result." : "Type: away fixture" };
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [block], timestamp: Date.now(), stopReason: ask ? "toolUse" : "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			if (last?.role === "toolResult" && last.toolName === "ask") {
				let outcome = "unexpected";
				try {
					if (!last.isError && text.startsWith("User answers:\n")) {
						const data: unknown = JSON.parse(text.slice("User answers:\n".length));
						if (Bun.deepEquals(data, {mode:"blue", note:"guest proof"})) outcome = "blue/guest proof";
						if (Bun.deepEquals(data, {mode:"green", note:"desktop proof"})) outcome = "green/desktop proof";
					}
				} catch { /* Don't record unrecognized transcript contents. */ }
				trace("provider_received_native_values", outcome);
			}
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				if (block.type === "toolCall") {
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		},
	});
	const offers = new Map<string, PendingAsk>(); // Retain old capabilities deliberately for stale-delivery tests.
	let counter = 0;
	let close: (() => void) | undefined;
	pi.on("session_start", (_, ctx) => {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
		const unsubscribe = pi.events.on("omp-away:pending-ask", payload => {
			const offer = payload as PendingAsk;
			if (offer.html !== form || !offer.toolCallId.startsWith("fixture-")) return;
			offers.set(offer.requestId, offer);
			writeFileSync(join(mail, `ask-${++counter}.json`), JSON.stringify({ requestId: offer.requestId }), { flag: "wx", mode: 0o600 });
			trace("presented", String(counter));
		});
		const watcher = watch(mail, (_event, filename) => {
			const match = filename && /^confirm-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(filename);
			if (!match) return;
			// Directory creation is atomic. Watchers may emit the same rename more than once.
			try { rmdirSync(join(mail, filename!)); } catch { return; }
			const [, id, receipt] = match;
			const offer = offers.get(id);
			const done = (status: string) => {
				trace("delivery", status);
				writeFileSync(join(mail, `receipt-${receipt}`), status, { flag: "wx", mode: 0o600 });
			};
			if (!offer) return done("stale");
			void offer.submitConfirmed(id, {mode:"blue", note:"guest proof"}).then(done, () => done("error"));
		});
		close = () => { watcher.close(); unsubscribe(); offers.clear(); };
	});
	pi.on("session_shutdown", () => close?.());
	pi.on("agent_start", (_, ctx) => { if (ctx.agent.kind === "main") trace("agent_start"); });
	pi.on("agent_end", (_, ctx) => { if (ctx.agent.kind === "main") trace("agent_end"); });
	pi.on("tool_execution_end", (e, ctx) => {
		if (ctx.agent.kind === "main" && e.toolName === "ask") trace("ask_execution_end", e.isError ? "error" : "ok");
	});
}
