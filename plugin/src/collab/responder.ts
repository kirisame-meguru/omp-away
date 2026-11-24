import type { CollabUiRequest, CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { firstPrompt, type FormValues, matches, planAnswers, type PreparedForm, type Step, tagForm } from "./form";

type Dispatch = "accepted" | "stale";
export interface Responder {
	prepare(requestId: string, html: string): string;
	accept(request: CollabUiRequest): boolean;
	end(reqId: number): void;
	clear(): void;
	submitConfirmed(requestId: string, values: FormValues): Promise<Dispatch>;
	withdraw(requestId: string): Promise<Dispatch>;
}

interface Call {
	id: string;
	form: PreparedForm;
	highestId: number;
	open?: { reqId: number; draft: CollabUiRequestDraft; sent: boolean };
	submission?: { steps: Generator<Step>; next: Step | undefined; writing: boolean; finish(status: Dispatch): void };
}

/** One exclusive native Ask in one host generation. The caller clears on tool end, loss, or generation change. */
export function createResponder(reply: (id: number, value?: string) => Promise<boolean>): Responder {
	let current: Call | undefined;

	function clear() {
		const previous = current;
		current = undefined;
		previous?.submission?.finish("stale");
	}

	async function dispatch(call: Call): Promise<void> {
		const { open, submission } = call;
		if (call !== current || !open || open.sent || !submission || submission.writing) return;
		const step = submission.next;
		if (!step || !matches(step.expected, open.draft)) return clear();

		// Reserve this exact reqId before calling out. end + next request can arrive while the write promise settles.
		open.sent = true;
		submission.writing = true;
		try {
			const next = submission.steps.next();
			submission.next = next.done ? undefined : next.value;
			const written = await reply(open.reqId, step.value);
			if (current !== call) return;
			if (!written) return clear();
			submission.writing = false;
			if (!submission.next) {
				// Transport dispatch only; the native Ask result, not a successful send, decides the winner.
				current = undefined;
				submission.finish("accepted");
			} else if (call.open !== open) {
				void dispatch(call);
			}
		} catch {
			if (current === call) clear();
		}
	}

	return {
		prepare(id: string, html: string): string {
			clear();
			if (!id) return html;
			try {
				const form = tagForm(html);
				if (!form) return html;
				current = { id, form, highestId: 0 };
				return form.html;
			} catch {
				// Parsing or tagging unfamiliar markup must never prevent the original desktop Ask.
				return html;
			}
		},
		/** True exactly once, on binding the first genuine guest prompt (safe to publish the request). */
		accept(request: CollabUiRequest): boolean {
			const call = current;
			if (!call) return false;
			const { reqId, ...draft } = request;
			const expected = call.submission ? call.submission.next?.expected : firstPrompt(call.form);
			if (call.open || !Number.isSafeInteger(reqId) || reqId <= call.highestId || !expected || !matches(expected, draft)) {
				clear();
				return false;
			}
			call.highestId = reqId;
			call.open = { reqId, draft, sent: false };
			if (!call.submission) return true;
			void dispatch(call);
			return false;
		},
		end(reqId: number): void {
			const call = current;
			if (!call) return;
			if (Number.isSafeInteger(reqId)) call.highestId = Math.max(call.highestId, reqId);
			if (call.open?.reqId !== reqId) return;
			if (!call.open.sent) return clear(); // Ended before we replied: a desktop win or cancellation.
			delete call.open;
		},
		clear,
		async withdraw(id: string): Promise<Dispatch> {
			const call = current;
			if (!call || call.id !== id || !call.open || call.open.sent || call.submission) return "stale";
			call.open.sent = true;
			return await reply(call.open.reqId) ? "accepted" : "stale";
		},
		async submitConfirmed(id: string, values: FormValues): Promise<Dispatch> {
			const call = current;
			if (!call || call.id !== id || !call.open || call.submission) return "stale";
			const steps = planAnswers(call.form, values);
			if (!steps) return "stale";
			const first = steps.next();
			if (first.done) return "stale";
			const { promise, resolve } = Promise.withResolvers<Dispatch>();
			call.submission = { steps, next: first.value, writing: false, finish: resolve };
			void dispatch(call);
			return promise;
		},
	};
}
