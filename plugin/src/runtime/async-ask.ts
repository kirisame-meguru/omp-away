import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AnswerNote, PendingAsk, Values } from "../index";
import type { Admin } from "./index";
import { isRoute } from "../secure-channel/framing";

// Structural v1 contract: neither installed plugin imports or depends on the other.
type DeliveryState = "submitted" | "queued" | "recorded" | "unconfirmed" | "failed";
export type QuestionSubmission =
	| { kind: "accepted" | "saved"; answerId: string; delivery: DeliveryState }
	| { kind: "stale" | "invalid" | "uncertain" };
export interface AsyncQuestion {
	readonly id: string; readonly requestId: string; readonly toolCallId: string; readonly title: string;
	readonly html: string; readonly blockedWork: string; readonly createdAt: number;
	readonly supportsOptionNotes?: boolean;
	submitConfirmed(values: Values, notes?: AnswerNote[]): QuestionSubmission;
	withdraw?(reason: string): { kind: "withdrawn" | "stale" };
}
export interface QuestionSource {
	readonly version: 1; readonly sessionId: string; readonly signal: AbortSignal;
	subscribe(listener: (questions: readonly AsyncQuestion[]) => void): () => void;
}
export interface AsyncAskConnection { close(): void }
interface Offer { question: AsyncQuestion; pending: PendingAsk; active: boolean }
interface Binding {
	source: QuestionSource; offers: Map<string, Offer>; revision: number;
	onAbort(): void; unsubscribe?: () => void;
}
const AVAILABLE = "omp-async-ask:available:v1", CONNECT = "omp-async-ask:connect:v1";
const bounded = (value: unknown, size: number): value is string => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= size;
function question(value: unknown): value is AsyncQuestion {
	return isRecord(value) && bounded(value.id, 256) && isRoute(value.requestId) && bounded(value.toolCallId, 256) &&
		bounded(value.title, 4096) && bounded(value.blockedWork, 4096) && bounded(value.html, 65536) &&
		typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && typeof value.submitConfirmed === "function";
}
function outcome(value: unknown): value is QuestionSubmission {
	if (!isRecord(value)) return false;
	if (value.kind === "stale" || value.kind === "invalid" || value.kind === "uncertain") return true;
	return (value.kind === "accepted" || value.kind === "saved") && bounded(value.answerId, 256) &&
		(value.delivery === "submitted" || value.delivery === "queued" || value.delivery === "recorded" || value.delivery === "unconfirmed" || value.delivery === "failed");
}

/** One Away host generation; the source owns every canonical question and submission. */
export function connectAsyncQuestions(
	events: Pick<ExtensionAPI["events"], "on" | "emit">,
	sessionId: string,
	admin: Pick<Admin, "offer" | "end">,
	ctx: ExtensionContext,
	report: (code: string) => void,
): AsyncAskConnection {
	let live = true, generation = 0, binding: Binding | undefined;
	const current = () => live && ctx.sessionManager.getSessionId() === sessionId;
	function warn(code: string) { if (current()) { try { report(code); } catch { /* UI failure cannot authorize or repeat a submission. */ } } }
	function retire(offer: Offer) {
		if (!offer.active) return;
		offer.active = false;
		try { admin.end(offer.pending.requestId); } catch { warn("async-source-invalid"); }
	}
	function detach() {
		generation++;
		const old = binding; binding = undefined;
		if (!old) return;
		old.source.signal.removeEventListener("abort", old.onAbort);
		try { old.unsubscribe?.(); } catch { warn("async-source-invalid"); }
		for (const offer of old.offers.values()) retire(offer);
		old.offers.clear();
	}
	function accept(value: unknown) {
		if (!current() || !isRecord(value) || value.version !== 1 || value.sessionId !== sessionId ||
			!(value.signal instanceof AbortSignal) || value.signal.aborted || typeof value.subscribe !== "function") return;
		// The public envelope above was checked; question data is checked in every snapshot.
		const source = value as unknown as QuestionSource;
		if (binding?.source === source) return;
		const epoch = generation + 1;
		detach();
		if (generation !== epoch || !current() || source.signal.aborted) return;
		const next: Binding = { source, offers: new Map(), revision: 0, onAbort() { if (binding === next) detach(); } };
		binding = next;
		const owned = () => current() && binding === next && !source.signal.aborted;
		source.signal.addEventListener("abort", next.onAbort, { once: true });
		try {
			const unsubscribe = source.subscribe(snapshot => {
				if (!owned()) return;
				try {
					if (!Array.isArray(snapshot) || snapshot.length > 32 || !snapshot.every(question) || new Set(snapshot.map(item => item.id)).size !== snapshot.length || new Set(snapshot.map(item => item.requestId)).size !== snapshot.length) throw Error("invalid-source");
					const revision = ++next.revision;
					const pendingIds = new Set(snapshot.map(item => item.id));
					for (const [id, offer] of next.offers) {
						if (!owned() || next.revision !== revision) return;
						if (!pendingIds.has(id)) { next.offers.delete(id); retire(offer); }
					}
					for (const item of snapshot) {
						if (!owned() || next.revision !== revision) return;
						const previous = next.offers.get(item.id);
						if (previous) {
							if (previous.question.requestId !== item.requestId || previous.question.html !== item.html || previous.question.toolCallId !== item.toolCallId || previous.question.createdAt !== item.createdAt) throw Error("changed-question");
							continue;
						}
						const requestId = item.requestId;
						const submit = item.submitConfirmed.bind(item);
						const offer: Offer = {
							question: Object.freeze({ ...item }), active: true,
							pending: {
								requestId, toolCallId: item.toolCallId, deduplicationKey: `async:${requestId}`,
								html: item.html, createdAt: item.createdAt, context: { title: item.title, blockedWork: item.blockedWork },
								supportsOptionNotes: item.supportsOptionNotes === true,
								...(typeof item.withdraw === "function" ? {
									async withdraw(id: string, reason: string) {
										if (id !== requestId || !owned() || !offer.active || next.offers.get(item.id) !== offer) return "stale" as const;
										const result = item.withdraw!(reason);
										return result.kind === "withdrawn" ? "accepted" as const : "stale" as const;
									},
								} : {}),
								async submitConfirmed(id, values, notes = []) {
									if (id !== requestId || !owned() || !offer.active || next.offers.get(item.id) !== offer) return "stale";
									if (notes.length && item.supportsOptionNotes !== true) return "stale";
									// Fence synchronous source callbacks before invoking the canonical submission.
									offer.active = false;
									let result: unknown;
									try { result = submit(values, notes); } catch { result = { kind: "uncertain" }; }
									try { admin.end(requestId); } catch { warn("async-source-invalid"); }
									// Canonical submission may synchronously remove this offer; keep its own receipt.
									const receipt: QuestionSubmission = outcome(result) ? result : { kind: "uncertain" };
									if (receipt.kind === "accepted" && (receipt.delivery === "queued" || receipt.delivery === "recorded")) return "accepted";
									if (owned() && receipt.kind !== "stale") warn(`async-answer-${receipt.kind === "accepted" ? "uncertain" : receipt.kind}`);
									return "stale";
								},
							},
						};
						next.offers.set(item.id, offer);
						admin.offer(offer.pending, ctx);
					}
				} catch { if (binding === next) detach(); warn("async-source-invalid"); }
			});
			if (typeof unsubscribe !== "function") throw Error("invalid-subscription");
			if (binding === next) next.unsubscribe = unsubscribe;
			else unsubscribe();
		} catch { if (binding === next) detach(); warn("async-source-invalid"); }
	}
	function request() {
		if (!current()) return;
		try { events.emit(CONNECT, { version: 1, sessionId, accept }); }
		catch { warn("async-source-invalid"); }
	}
	const unsubscribe = events.on(AVAILABLE, value => {
		if (isRecord(value) && value.version === 1 && value.sessionId === sessionId) request();
	});
	request();
	return { close() { if (!live) return; live = false; unsubscribe(); detach(); } };
}
