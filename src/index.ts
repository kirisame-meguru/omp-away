import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { type Adapter, startAdapter } from "./collab/adapter";
import { createResponder, type Responder } from "./collab/responder";

type Values = Record<string, string | number | boolean | string[]>;
type Delivery = "accepted" | "stale";

/** In-process, request-scoped capability for a trusted confirmation UI. Not an agent tool. */
export interface PendingAsk {
	requestId: string;
	html: string;
	toolCallId: string;
	submitConfirmed(requestId: string, values: Values): Promise<Delivery>;
}

interface Call {
	id: string;
	html: string;
	tagged: string;
	responder: Responder;
	native: PromiseWithResolvers<unknown>;
	offered: boolean;
	submitting: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The native Ask's structured details contain *display labels*. Its first text block
// contains the actual HTML submission. Do not infer success from labels or a WS send.
function nativeValues(result: unknown): unknown {
	if (!record(result) || !record(result.details) || result.details.timedOut || !Array.isArray(result.details.answers)) return;
	const block = Array.isArray(result.content) ? result.content[0] : undefined;
	if (!record(block) || block.type !== "text" || typeof block.text !== "string") return;
	const prefix = "User answers:\n";
	if (!block.text.startsWith(prefix)) return;
	try {
		const data: unknown = JSON.parse(block.text.slice(prefix.length).split("\nOption notes:\n", 1)[0]);
		if (record(data)) return data;
	} catch { /* Unknown rendering: never acknowledge. */ }
}

function configuredPort(pi: ExtensionAPI): number | undefined {
	const read = (key: string) => lookup(key)?.get(pi.pi.settings);
	if (read("collab.autoStart") !== "control" || read("ask.timeout") !== 0) return;
	const relay = read("collab.relayUrl");
	const match = typeof relay === "string" && /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(relay);
	if (match && Number(match[1]) <= 65535) return Number(match[1]);
}

/** Each factory owns exactly one host session. Room loss invalidates even a same-session Ask. */
export default function away(pi: ExtensionAPI): void {
	let session: string | undefined;
	let generation = 0;
	let adapter: Adapter | undefined;
	let ready = false;
	let activeId: string | undefined;
	const approvals = new Set<string>();
	const calls = new Map<string, Call>();
	const owns = (ctx: ExtensionContext) => ctx.agent.kind === "main" && session === ctx.sessionManager.getSessionId();

	function finish(key: string, data?: unknown) {
		const call = calls.get(key);
		if (!call) return;
		calls.delete(key);
		if (activeId === key) activeId = undefined;
		call.native.resolve(data);
		call.responder.clear();
	}
	function discard() {
		for (const key of calls.keys()) finish(key);
	}
	async function stop() {
		generation++;
		session = undefined;
		ready = false;
		approvals.clear();
		discard();
		const old = adapter;
		adapter = undefined;
		await old?.close();
	}

	function offer(toolCallId: string, call: Call) {
		call.offered = true;
		const requestId = call.id;
		const pending: PendingAsk = {
			requestId, toolCallId, html: call.html,
			async submitConfirmed(id, values) {
				if (id !== requestId || activeId !== toolCallId || calls.get(toolCallId) !== call || !ready || approvals.size || call.submitting) return "stale";
				call.submitting = true;
				try {
					const snapshot = structuredClone(values);
					if (await call.responder.submitConfirmed(id, snapshot) !== "accepted") return "stale";
					const actual = await call.native.promise;
					return actual !== undefined && Bun.deepEquals(actual, snapshot) ? "accepted" : "stale";
				} finally { call.submitting = false; }
			},
		};
		pi.events.emit("omp-away:pending-ask", pending);
	}

	async function start(ctx: ExtensionContext) {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
		const closing = stop();
		const epoch = generation;
		await closing;
		if (epoch !== generation) return;
		const port = configuredPort(pi);
		if (!port) {
			ctx.ui.notify("Away unavailable: set collab.relayUrl=ws://127.0.0.1:<port>, collab.autoStart=control and ask.timeout=0 in this profile.", "error");
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		session = sessionId;
		try {
			const next = await startAdapter(port, sessionId, {
				ready() {
					if (epoch === generation) { ready = true; ctx.ui.notify("Away: local guest ready", "info"); }
				},
				unavailable(reason: string) {
					if (epoch === generation) ctx.ui.notify(`Away unavailable: ${reason}`, "error");
				},
				lost() {
					if (epoch === generation) { ready = false; discard(); }
				},
				request(request) {
					if (epoch !== generation || !ready || approvals.size || !activeId) return;
					const call = calls.get(activeId);
					if (call?.responder.accept(request) && !call.offered) offer(activeId, call);
				},
				end(reqId) {
					if (epoch === generation && activeId) calls.get(activeId)?.responder.end(reqId);
				},
			});
			if (epoch === generation) adapter = next;
			else await next.close();
		} catch {
			if (epoch === generation) {
				ready = false;
				discard();
				ctx.ui.notify("Away unavailable: could not open the configured loopback adapter. Check port ownership.", "error");
			}
		}
	}

	pi.on("session_start", (_, ctx) => start(ctx));
	pi.on("session_switch", (_, ctx) => start(ctx));
	pi.on("session_branch", (_, ctx) => start(ctx));
	pi.on("session_before_switch", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("session_before_branch", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("session_before_tree", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("session_clear", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("agent_end", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("session_shutdown", (_, ctx) => { if (ctx.agent.kind === "main") return stop(); });

	pi.on("tool_call", (event, ctx) => {
		if (!owns(ctx) || event.toolName !== "ask" || !ready || !adapter || typeof event.input.html !== "string") return;
		const source = pi.getAllTools().filter(tool => tool.name === "ask");
		if (source.length !== 1 || source[0].sourceInfo.source !== "builtin" || source[0].sourceInfo.path !== "<builtin:ask>") return;
		const key = event.toolCallId;
		if (calls.has(key)) { finish(key); return; }
		const html = event.input.html;
		const id = crypto.randomUUID();
		const link = adapter;
		const responder = createResponder((reqId, value) =>
			ready && adapter === link && !approvals.size && activeId === key && calls.get(key)?.id === id
				? link.reply(reqId, value) : Promise.resolve(false));
		const tagged = responder.prepare(id, html);
		if (tagged === html) return;
		calls.set(key, { id, html, tagged, responder, native: Promise.withResolvers(), offered: false, submitting: false });
		return { input: { ...event.input, html: tagged } };
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (!owns(ctx) || event.toolName !== "ask") return;
		const key = event.toolCallId;
		const call = calls.get(key);
		if (activeId) { finish(activeId); finish(key); return; }
		if (call && record(event.args) && event.args.html === call.tagged) activeId = key;
		else finish(key);
	});
	pi.on("tool_approval_requested", event => {
		if (event.sessionId !== session) return;
		approvals.add(event.toolCallId);
		// A new approval after we have offered a form invalidates the offer. A
		// pre-execution approval must be settled locally before the form can open.
		if (activeId && calls.get(activeId)?.offered) finish(activeId);
	});
	pi.on("tool_approval_resolved", event => {
		if (event.sessionId === session) approvals.delete(event.toolCallId);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (owns(ctx) && event.toolName === "ask") finish(event.toolCallId, !event.isError && activeId === event.toolCallId ? nativeValues(event.result) : undefined);
	});
}
