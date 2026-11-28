import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { logger } from "@oh-my-pi/pi-utils";
import { type Adapter, startAdapter } from "./collab/adapter";
import { createResponder, type Responder } from "./collab/responder";
import { type Admin, gatewayConfigured, openAdmin } from "./runtime";
import { awaySuggestions } from "./runtime/commands";
import { connectAsyncQuestions, type AsyncAskConnection } from "./runtime/async-ask";
import { AwayNotifications } from "./runtime/notifications";
import { CallMessage, clean, createCallRenderers, createEndCallRenderers } from "./presentation";
import { message } from "./messages";

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
	const language = () => notifications?.language ?? "en";
	const t = (english: string) => message(language(), english);
	for (const customType of ["omp-away:call", "omp-away:call-result"]) {
		// Keep local disclosure state across host/theme invalidation.
		const views = new WeakMap<object, { view: CallMessage; expanded: boolean }>();
		pi.registerMessageRenderer(customType, (message, options) => {
			let cached = views.get(message);
			if (!cached || cached.view.language !== language()) {
				const content = typeof message.content === "string" ? message.content
					: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
				cached = { view: new CallMessage(content, customType === "omp-away:call-result", options.expanded, language()), expanded: options.expanded };
				views.set(message, cached);
			} else if (cached.expanded !== options.expanded) {
				cached.expanded = options.expanded;
				cached.view.setExpanded(options.expanded);
			}
			return cached.view.view;
		});
	}
	let session: string | undefined;
	let generation = 0;
	let adapter: Adapter | undefined;
	let admin: Admin | undefined;
	let opening: Promise<void> | undefined;
	let asyncQuestions: AsyncAskConnection | undefined;
	let notifications: AwayNotifications | undefined;
	let mobileConfigured = false;
	let ready = false;
	let activeId: string | undefined;
	// A native Ask is exclusive, so `away_call` can only arm the next one in this turn.
	let armedCall: number | undefined;
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
		armedCall = undefined;
		for (const key of calls.keys()) finish(key);
	}
	async function stop() {
		generation++;
		session = undefined;
		ready = false;
		notifications?.close(); notifications = undefined;
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
		if (mobileConfigured) {
			if(admin) {
				admin.offer(pending, voiceContext(call.ctx));
				if (armedCall !== undefined && Date.now() < armedCall) ring(admin, requestId);
				armedCall = undefined;
			}
			else notifications?.warn("mobile-outage","This question could not be forwarded to the phone. Answer on the desktop; inspect /away status.");
		} else pi.events.emit("omp-away:pending-ask", pending); // isolated local-gate integration only
		// Observe only after delivery; no capability, question, or session context crosses this boundary.
		queueMicrotask(() => {
			try { pi.events.emit("omp-away:offer-observed", Object.freeze({ toolCallId, requestId })); }
			catch { /* A broken observer must not interrupt the native Ask. */ }
		});
	}

	function ring(mobile: Admin, requestId: string) {
		const epoch = generation;
		void mobile.call(requestId).then(outcome => {
			if (epoch !== generation) return;
			logger.info("Away call", { outcome });
			if (outcome === "unavailable") notifications?.warn(`call:${requestId}`, "The phone call could not be started. Answer on the desktop or open the phone inbox.");
		}, () => { if (epoch === generation) notifications?.diagnostic("invite-unavailable"); });
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
		const feedback = new AwayNotifications((text,type)=>{if(epoch===generation) ctx.ui.notify(text,type)});
		notifications = feedback;
		feedback.health("Mobile gateway",mobileConfigured?"Starting":"Not configured");
		feedback.health("Native Ask","Connecting");
		feedback.health("Async inbox",mobileConfigured?"Waiting for question source":"Mobile forwarding not configured");
		if (mobileConfigured) opening = openAdmin(ctx, () => epoch === generation, () => !calls.size && !approvals.size && ctx.isIdle(), undefined, feedback).then(async mobile => {
			if (epoch === generation && mobile) {
				admin = mobile;
				asyncQuestions = connectAsyncQuestions(pi.events, sessionId, mobile, voiceContext(ctx), (code,requestId) => {
					if (epoch !== generation) return;
					feedback.diagnostic(code);
					if(code==="async-source-invalid") {feedback.health("Async inbox","Unavailable; use /questions");return}
					const message = code === "async-answer-saved"
						? "Async answer saved, but delivery was not confirmed. Review /questions; nothing was resent."
						: code === "async-answer-uncertain"
							? "Async answer persistence or delivery is uncertain. Review /questions before retrying."
							: code === "async-answer-invalid"
								? "Async answer was rejected. Complete this question in /questions."
								: "Async inbox integration unavailable. Continue in /questions.";
					feedback.warn(code==="async-forwarding-unavailable"?"async-forwarding":`answer:${requestId}`,message);
				}, state => {
					if(epoch!==generation) return;
					feedback.health("Async inbox",state==="ready"?"Connected":"Disconnected; waiting for question source");
					if(state==="ready") feedback.recover("async-forwarding");
				});
			} else await mobile?.close();
		}).catch(error => {
			if (epoch !== generation) return;
			const code=error instanceof Error && error.message==="shared-routing-upgrade-required" ? error.message : "secure_helper_failed";
			feedback.diagnostic(code);
			feedback.health("Mobile gateway",code==="shared-routing-upgrade-required"
				? "Upgrade required: close Away-enabled desktops, wait 10 seconds, then reopen with the updated plugin. Pairing is preserved."
				: "Unavailable: check gateway settings and private token/state paths, then restart Away. Desktop Ask remains available.");
			feedback.health("Async inbox","Mobile forwarding unavailable; use /questions");
			feedback.cancel("mobile-outage");
		});
		const port = configuredPort(pi);
		if (!port) {
			logger.info("Away native bridge", { stage:"configuration-unavailable" });
			feedback.health("Native Ask","Not configured: set collab.relayUrl=ws://127.0.0.1:<port>, collab.autoStart=control and ask.timeout=0. Async inbox does not require Collab.");
			return;
		}
		try {
			const next = await startAdapter(port, sessionId, {
				ready() {
					if (epoch === generation) {
						ready = true; logger.info("Away native bridge", { stage:"adapter-ready" });
						feedback.health("Native Ask","Available");feedback.recover("native-forwarding");
					}
				},
				unavailable(reason: string) {
					if (epoch === generation) {
						logger.info("Away native bridge", { stage:"adapter-unavailable" });
						feedback.diagnostic("native-unavailable");
						feedback.health("Native Ask",language=>`${message(language,"Unavailable")}: ${message(language,clean(reason))}`);
					}
				},
				lost() {
					if (epoch === generation) {
						const affected=[...calls.values()].some(call=>call.offered);
						ready = false; discard();
						feedback.health("Native Ask","Disconnected");
						if(affected && admin?.ringing) feedback.warn("native-forwarding","Native Ask forwarding stopped for a pending question. Answer on the desktop; inspect /away status.");
					}
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
				feedback.diagnostic("native-unavailable");
				feedback.health("Native Ask","Unavailable: could not open the loopback adapter; check port ownership.");
			}
		}
	}

	const callParameters = pi.arktype({ "questionId?": "string", "nativeAsk?": "boolean" });
	pi.registerTool<typeof callParameters>({
		name: "away_call",
		get label() { return t("Call phone"); },
		description: "Optional: ring the user's paired Away phone like an incoming phone call so they can discuss a pending question by voice. Ordinary questions only appear as phone notifications that can be answered by touch; use this only when a live voice conversation is genuinely useful or urgent. A call always belongs to a pending question: pass `questionId` from an `ask_async` question that is still pending, or `nativeAsk: true` to ring for the native `ask` you invoke next. Because native `ask` blocks, emit `away_call` with `nativeAsk: true` immediately before `ask` in the same response; the arm lapses when the turn ends. For `questionId`, this waits up to 45 seconds and reports answered, declined, missed or closed. Never ring repeatedly for the same question after a decline or miss.",
		parameters: callParameters,
		approval: "write",
		...createCallRenderers(language),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if ((params.questionId === undefined) === (params.nativeAsk !== true)) throw Error("Pass exactly one of questionId or nativeAsk: true.");
			if (!owns(ctx) || !admin) throw Error("Away phone forwarding is unavailable in this session. Leave the question pending.");
			if (params.nativeAsk) {
				if (!ready || !adapter) throw Error("Native Ask forwarding is unavailable; the phone cannot be called for a native ask. Use ask_async with away_call questionId, or ask normally.");
				armedCall = Date.now() + 120_000;
				return {
					content: [{ type: "text", text: "Call armed. The phone rings when your next native ask opens in this turn; call ask now." }],
					details: { outcome: "armed" },
				};
			}
			const requestId = asyncQuestions?.requestId(params.questionId!);
			if (!requestId) throw Error("No pending async question with that ID is forwarded to the phone.");
			const aborted = Promise.withResolvers<never>();
			const onAbort = () => aborted.reject(signal!.reason);
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const outcome = await Promise.race([admin.call(requestId), aborted.promise]);
				const text = {
					answered: "The user picked up; voice setup for this question was requested. Pickup is not proof that audio is ready.",
					declined: "The user declined the call. The question stays pending; do not call again for it.",
					missed: "The call was not answered within 45 seconds. The question stays pending and remains available as a phone notification.",
					closed: "The question became unavailable before the call was answered.",
					unavailable: "The phone could not be called for this question (no paired phone, an active call, or it is no longer pending).",
				}[outcome];
				return { content: [{ type: "text", text }], details: { outcome } };
			} finally { signal?.removeEventListener("abort", onAbort); }
		},
	});

	const endCallParameters = pi.arktype({ requestId: "string" });
	pi.registerTool<typeof endCallParameters>({
		name: "away_end_call",
		get label() { return t("End Away call"); },
		description: "End this session's Away voice call when realtime voice requests completion of the exchange, or immediately when the user asks to hang up. If the user requested an answer from the coding agent, return a normal final answer first without invoking this tool; native voice must speak it before requesting completion. Terminal text, silent commentary, and handoff acknowledgments do not establish spoken delivery. Use the requestId from the omp-away-plugin call context. This stops handset audio and native live mode; it does not submit an answer or resolve a pending form. Do not add extra confirmations or keep a completed conversation open for implementation work. After ending, apply the spoken outcome and resume interrupted work, or start the authorized work that was waiting for the answer. Honor explicit instructions to stop work; otherwise do not end on a pause or during necessary clarification.",
		parameters: endCallParameters,
		loadMode: "essential",
		approval: "write",
		...createEndCallRenderers(language),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const ended = owns(ctx) && !!admin && await admin.endCall(params.requestId);
			return {
				content: [{ type: "text", text: t(ended ? "Away call ended." : "No matching active Away call in this session.") }],
				details: { ended },
			};
		},
	});

	pi.registerCommand("away", {
		get description() { return t("Enable Away for all connected sessions; /away off disables immediate phone notifications"); },
		getArgumentCompletions: prefix => awaySuggestions(prefix, admin?.comparisonCode)?.map(item=>({...item,description:t(item.description)})) ?? null,
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
			if (args.trim()==="help") {
				const help=(awaySuggestions("") ?? []).filter(item=>item.value!=="help").map(item=>`/away ${item.label} — ${t(item.description)}`).join("\n");
				ctx.ui.notify(help,"info"); return;
			}
			if (!owns(ctx)) return;
			if(args.trim()==="status") {
				const epoch=generation;
				await opening;
				if(epoch!==generation || !owns(ctx)) return;
				if(admin) await admin.command("status");
				else ctx.ui.notify(clean(`${t("Away status")}\n${notifications?.status() ?? t("Not initialized")}`),"info");
				return;
			}
			if (!admin) { ctx.ui.notify(t("Away mobile unavailable. Check the gateway settings in the plugin DEBUG guide."), "error"); return; }
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
		if (!owns(ctx) || event.toolName !== "ask" || typeof event.input.html !== "string") return;
		const source = pi.getAllTools().filter(tool => tool.name === "ask");
		if (source.length !== 1 || source[0].sourceInfo.source !== "builtin" || source[0].sourceInfo.path !== "<builtin:ask>") return;
		if(!ready || !adapter) {
			if(mobileConfigured && (!admin || admin.ringing)) notifications?.warn("native-forwarding","This question cannot be forwarded through native Ask right now. Answer on the desktop; inspect /away status.");
			return;
		}
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
			content: [{ ...first, text: first.text + `\n${t("Option notes")}:\n` + JSON.stringify(answer.notes) }, ...event.content.slice(1)],
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
