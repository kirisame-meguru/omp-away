import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { logger } from "@oh-my-pi/pi-utils";
import { type Adapter, startAdapter } from "./collab/adapter";
import { createResponder, type Responder } from "./collab/responder";
import { type Admin, gatewayConfigured, openAdmin } from "./runtime";
import { awayHelp, awaySuggestions } from "./runtime/commands";
import { connectAsyncQuestions, type AsyncAskConnection } from "./runtime/async-ask";

export type Values = Record<string, string | number | boolean | string[]>;
export interface AnswerNote { name: string; question: string; option: string; value: string; text: string }
export interface QuestionContext { title: string; blockedWork: string }
type Delivery = "accepted" | "stale";

/** In-process, request-scoped capability for a trusted confirmation UI. Not an agent tool. */
export interface PendingAsk {
	requestId: string;
	html: string;
	toolCallId: string;
	deduplicationKey?: string;
	createdAt?: number;
	context?: QuestionContext;
	supportsOptionNotes?: boolean;
	submitConfirmed(requestId: string, values: Values, notes?: AnswerNote[]): Promise<Delivery>;
	withdraw?(requestId: string, reason: string): Promise<Delivery>;
	takeOver?(requestId: string): Promise<Delivery>;
}

interface Call {
	id: string;
	html: string;
	ctx: ExtensionContext;
	firstTicket?: number;
	tagged: string;
	responder: Responder;
	native: PromiseWithResolvers<unknown>;
	offered: boolean;
	submitting: boolean;
	touchAnswer?: { values: Values; notes: AnswerNote[]; notesApplied: boolean };
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
	let admin: Admin | undefined;
	let opening: Promise<void> | undefined;
	let asyncQuestions: AsyncAskConnection | undefined;
	let mobileConfigured = false;
	let ready = false;
	let activeId: string | undefined;
	const approvals = new Set<string>();
	const calls = new Map<string, Call>();
	const contextDeliveries = new Map<string, { done(): void; cancel(): void }>();
	const owns = (ctx: ExtensionContext) => ctx.agent.kind === "main" && session === ctx.sessionManager.getSessionId();
	const voiceContext = (ctx: ExtensionContext) => Object.assign(Object.create(ctx) as ExtensionContext, {
		awayContext: (content: string) => new Promise<void>((resolve, reject) => {
			const id = crypto.randomUUID();
			const finish = (error?: Error) => {
				clearTimeout(timer); contextDeliveries.delete(id);
				if (error) reject(error); else resolve();
			};
			const timer = setTimeout(() => finish(Error("Call context was not delivered")), 20_000).unref();
			contextDeliveries.set(id, { done: () => finish(), cancel: () => finish(Error("Session changed")) });
			try {
				pi.sendMessage({
					customType: "omp-away:call", display: true, attribution: "agent", content,
					details: { awayContextId: id },
				}, ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "aside", triggerTurn: false });
			} catch (error) { finish(error instanceof Error ? error : Error("Call context unavailable")); }
		}),
	});

	function finish(key: string, data?: unknown) {
		const call = calls.get(key);
		if (!call) return;
		calls.delete(key);
		if (activeId === key) activeId = undefined;
		admin?.end(call.id);
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
		for (const delivery of contextDeliveries.values()) delivery.cancel();
		asyncQuestions?.close(); asyncQuestions = undefined;
		approvals.clear();
		discard();
		const old = adapter, mobile = admin, starting = opening;
		adapter = undefined; admin = undefined; opening = undefined;
		await Promise.all([old?.close(), mobile?.close(), starting]);
	}

	function offer(toolCallId: string, call: Call) {
		call.offered = true;
		logger.info("Away native bridge", { stage:"offered", mobile:mobileConfigured });
		const requestId = call.id;
		const pending: PendingAsk = {
			requestId, toolCallId, html: call.html, supportsOptionNotes: true,
			async takeOver(id) {
				if (id !== requestId || activeId !== toolCallId || calls.get(toolCallId) !== call || !ready || approvals.size || call.submitting) return "stale";
				call.submitting = true;
				const epoch = generation;
				try {
					if (await call.responder.withdraw(id) !== "accepted") return "stale";
					await call.native.promise;
					const deadline = Date.now() + 5000;
					while (!call.ctx.isIdle() && ready && generation === epoch && Date.now() < deadline) await delay(10);
					if (!call.ctx.isIdle()) return "stale";
					return ready && generation === epoch && owns(call.ctx) ? "accepted" : "stale";
				} finally { call.submitting = false; }
			},
			async withdraw(id, reason) {
				if (id !== requestId || activeId !== toolCallId || calls.get(toolCallId) !== call || !ready || approvals.size || call.submitting) return "stale";
				if (!reason.trim() || Buffer.byteLength(reason) > 16384) throw Error("Invalid call result");
				call.submitting = true;
				const epoch = generation;
				try {
					if (await call.responder.withdraw(id) !== "accepted") return "stale";
					await call.native.promise;
					if (!ready || generation !== epoch || !owns(call.ctx)) return "stale";
					// Native Ask cancellation aborts its turn. Resume only after it has
					// settled, using the host's teardown-safe continuation queue.
					pi.sendMessage({
						customType: "omp-away:call-result", display: true, attribution: "agent",
						content: JSON.stringify({ question: requestId, voiceDiscussion: reason }),
					}, { deliverAs: "nextTurn", triggerTurn: true });
					return "accepted";
				} finally { call.submitting = false; }
			},
			async submitConfirmed(id, values, notes = []) {
				if (id !== requestId || activeId !== toolCallId || calls.get(toolCallId) !== call || !ready || approvals.size || call.submitting) return "stale";
				call.submitting = true;
				logger.info("Away native bridge", { stage:"submit-started" });
				try {
					const snapshot = structuredClone(values);
					call.touchAnswer = { values: snapshot, notes: structuredClone(notes), notesApplied: notes.length === 0 };
					if (await call.responder.submitConfirmed(id, snapshot) !== "accepted") return "stale";
					const actual = await call.native.promise;
					const matched=actual !== undefined && Bun.deepEquals(actual, snapshot) && call.touchAnswer.notesApplied;
					logger.info("Away native bridge", { stage:"native-result", matched });
					return matched ? "accepted" : "stale";
				} finally { call.submitting = false; }
			},
		};
		if (mobileConfigured) admin?.offer(pending, voiceContext(call.ctx));
		else pi.events.emit("omp-away:pending-ask", pending); // isolated local-gate integration only
		// Observe only after delivery; no capability, question, or session context crosses this boundary.
		queueMicrotask(() => {
			try { pi.events.emit("omp-away:offer-observed", Object.freeze({ toolCallId, requestId })); }
			catch { /* A broken observer must not interrupt the native Ask. */ }
		});
	}

	async function start(ctx: ExtensionContext) {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
		const closing = stop();
		const epoch = generation;
		await closing;
		if (epoch !== generation) return;
		const sessionId = ctx.sessionManager.getSessionId();
		session = sessionId;
		mobileConfigured = gatewayConfigured();
		if (mobileConfigured) opening = openAdmin(ctx, () => epoch === generation, () => !calls.size && !approvals.size && ctx.isIdle()).then(async mobile => {
			if (epoch === generation && mobile) {
				admin = mobile;
				asyncQuestions = connectAsyncQuestions(pi.events, sessionId, mobile, voiceContext(ctx), code => {
					if (epoch !== generation) return;
					const message = code === "async-answer-saved"
						? "Async answer saved, but delivery was not confirmed. Review /questions; nothing was resent."
						: code === "async-answer-uncertain"
							? "Async answer persistence or delivery is uncertain. Review /questions before retrying."
							: code === "async-answer-invalid"
								? "Async answer was rejected. Complete this question in /questions."
								: "Async inbox integration unavailable. Continue in /questions.";
					ctx.ui.notify(`Away: ${message}`, "warning");
				});
			} else await mobile?.close();
		}).catch(error => {
			if (epoch !== generation) return;
			if (error instanceof Error && error.message==="shared-routing-upgrade-required") {
				ctx.ui.notify("Away shared routing needs a gateway upgrade: close all Away-enabled desktops, wait 10 seconds, then reopen them with the updated plugin. Pairing is preserved; Desktop Ask remains available.", "warning");
			} else ctx.ui.notify("Away mobile unavailable: check the HTTPS gateway, private token/state paths, routing preferences and tunnel Python. Desktop Ask remains available.", "error");
		});
		const port = configuredPort(pi);
		if (!port) {
			logger.info("Away native bridge", { stage:"configuration-unavailable" });
			ctx.ui.notify("Away native Ask forwarding unavailable: set collab.relayUrl=ws://127.0.0.1:<port>, collab.autoStart=control and ask.timeout=0. Async inbox forwarding does not require Collab.", "warning");
			return;
		}
		try {
			const next = await startAdapter(port, sessionId, {
				ready() {
					if (epoch === generation) {
						ready = true; logger.info("Away native bridge", { stage:"adapter-ready" });
						ctx.ui.notify("Away: local guest ready", "info");
					}
				},
				unavailable(reason: string) {
					if (epoch === generation) {
						logger.info("Away native bridge", { stage:"adapter-unavailable" });
						ctx.ui.notify(`Away unavailable: ${reason}`, "error");
					}
				},
				lost() {
					if (epoch === generation) { ready = false; discard(); }
				},
				request(request) {
					if (epoch !== generation || !ready || approvals.size || !activeId) return;
					const call = calls.get(activeId);
					if (!call) return;
					if (call.responder.accept(request) && !call.offered) {
						call.firstTicket = request.reqId;
						offer(activeId, call);
					} else if (call.offered && !call.submitting) finish(activeId);
				},
				end(reqId) {
					if (epoch !== generation || !activeId) return;
					const call = calls.get(activeId);
					call?.responder.end(reqId);
					if (call?.firstTicket === reqId && !call.submitting) finish(activeId);
				},
			});
			if (epoch === generation) {
				adapter = next;
				if(next.port!==port) lookup("collab.relayUrl")!.override(pi.pi.settings,`ws://127.0.0.1:${next.port}`);
			} else await next.close();
		} catch {
			logger.info("Away native bridge", { stage:"adapter-failed" });
			if (epoch === generation) {
				ready = false;
				discard();
				ctx.ui.notify("Away unavailable: could not open the configured loopback adapter. Check port ownership.", "error");
			}
		}
	}

	const endCallParameters = pi.arktype({ requestId: "string" });
	pi.registerTool<typeof endCallParameters>({
		name: "away_end_call",
		label: "End Away call",
		description: "End this session's Away voice call once its purpose is resolved or the user asks to hang up. Use the requestId from the omp-away-plugin call context. This stops handset audio and native live mode; it does not submit an answer. Do not leave a completed call open. Do not call while awaiting the user's answer or continuing the conversation.",
		parameters: endCallParameters,
		loadMode: "essential",
		approval: "write",
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const ended = owns(ctx) && !!admin && await admin.endCall(params.requestId);
			return {
				content: [{ type: "text", text: ended ? "Away call ended." : "No matching active Away call in this session." }],
				details: { ended },
			};
		},
	});

	pi.registerCommand("away", {
		description: "Enable Away for all connected sessions; /away off disables immediate ringing",
		getArgumentCompletions: prefix => awaySuggestions(prefix, admin?.comparisonCode),
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
			if (args.trim()==="help") { ctx.ui.notify(awayHelp,"info"); return; }
			if (!owns(ctx)) return;
			if (!admin) { ctx.ui.notify("Away mobile unavailable. Check the gateway settings in the plugin DEBUG guide.", "error"); return; }
			await admin.command(args);
		},
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!owns(ctx) || message.role !== "custom" || message.customType !== "omp-away:call" || !record(message.details)) return;
		const id = message.details.awayContextId;
		if (typeof id === "string") contextDeliveries.get(id)?.done();
	});
	pi.on("agent_start", (_, ctx) => { if (owns(ctx)) admin?.cancelEnrollment(); });
	pi.on("session_start", (_, ctx) => start(ctx));
	pi.on("session_switch", (_, ctx) => start(ctx));
	pi.on("session_branch", (_, ctx) => start(ctx));
	pi.on("session_tree", (_, ctx) => start(ctx));
	pi.on("session_clear", (_, ctx) => start(ctx));
	pi.on("session_before_switch", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("session_before_branch", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("session_before_tree", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("agent_end", (_, ctx) => { if (owns(ctx)) discard(); });
	pi.on("session_shutdown", (_, ctx) => { if (ctx.agent.kind === "main") return stop(); });

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "ask") logger.info("Away native bridge", { stage:"ask-seen", owned:owns(ctx), ready, adapter:!!adapter });
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
		calls.set(key, { id, html, ctx, tagged, responder, native: Promise.withResolvers(), offered: false, submitting: false });
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
	pi.on("tool_result", (event, ctx) => {
		if (!owns(ctx) || event.toolName !== "ask" || event.isError) return;
		const call = calls.get(event.toolCallId), answer = call?.touchAnswer;
		if (!call?.submitting || !answer?.notes.length || answer.notesApplied ||
			!Bun.deepEquals(nativeValues(event), answer.values) || !record(event.details)) return;
		const first = event.content[0];
		if (first?.type !== "text") return;
		answer.notesApplied = true;
		return {
			content: [{ ...first, text: first.text + "\nOption notes:\n" + JSON.stringify(answer.notes) }, ...event.content.slice(1)],
			details: { ...event.details, notes: structuredClone(answer.notes) },
		};
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (!owns(ctx) || event.toolName !== "ask") return;
		const notes = calls.get(event.toolCallId)?.touchAnswer?.notes;
		const notesMatch = !notes?.length || record(event.result) && record(event.result.details) && Bun.deepEquals(event.result.details.notes, notes);
		finish(event.toolCallId, !event.isError && activeId === event.toolCallId && notesMatch ? nativeValues(event.result) : undefined);
	});
}
