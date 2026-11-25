import { clean } from "../presentation";

const diagnostics: Readonly<Record<string, string>> = {
	phone_disconnected: "Phone transport interrupted",
	relay_disconnected: "Relay transport interrupted",
	phone_protocol_error: "Phone authentication or protocol rejected",
	phone_connection_failed: "Phone connection failed",
	"phone-control-unavailable": "Phone update failed",
	"invalidation-unavailable": "Phone notification retirement failed",
	"voice-close-unavailable": "Voice cleanup failed",
	"invite-unavailable": "Push invitation failed",
	"unsupported-form": "Question format unsupported",
	"voice-unavailable": "Voice setup or audio failed",
	"call-interrupted": "Active phone call disconnected",
	"async-source-invalid": "Async inbox integration unavailable",
	"async-answer-saved": "Async answer delivery unconfirmed",
	"answer-receipt-unavailable": "Phone answer receipt could not be delivered",
	"answer-uncertain": "Answer submission unconfirmed",
	"async-forwarding-unavailable": "Pending async questions lost mobile forwarding",
	"async-answer-uncertain": "Async answer persistence or delivery uncertain",
	"async-answer-invalid": "Async answer rejected",
	"native-unavailable": "Native Ask forwarding unavailable",
	"shared-routing-upgrade-required": "Shared gateway upgrade required",
	state_permissions_denied: "Private gateway state permissions rejected",
	relay_connection_failed: "Initial relay connection failed",
	shared_gateway_disconnected: "Shared gateway stopped",
	secure_helper_launch_failed: "Gateway helper could not start",
	secure_helper_closed: "Gateway helper stopped",
	secure_helper_pipe_failed: "Gateway helper connection failed",
	secure_helper_timeout: "Gateway helper operation timed out",
	secure_helper_start_timeout: "Gateway helper startup timed out",
	secure_helper_protocol_error: "Gateway helper protocol rejected",
	secure_helper_failed: "Gateway helper unavailable",
	secure_callback_failed: "Gateway callback failed",
	callback_failed: "Gateway cleanup callback failed",
	confirmation_failed: "Pairing confirmation failed",
};

/** Session-local presentation only. Never changes routing, retries or answer authority. */
export class AwayNotifications {
	readonly #health = new Map<string, string>();
	readonly #shown = new Set<string>();
	readonly #recent = new Map<string, number>();
	readonly #deferred = new Map<string, NodeJS.Timeout>();
	#closed = false;
	constructor(private readonly notify: (text: string, type: "info" | "warning" | "error") => void) {}

	health(area: string, state: string): void { if (!this.#closed) this.#health.set(area, state); }
	diagnostic(code: string): void {
		if (this.#closed) return;
		const key = Object.hasOwn(diagnostics, code) ? code : "unknown";
		const count = this.#recent.get(key) ?? 0;
		this.#recent.delete(key);
		this.#recent.set(key, count + 1);
		if (this.#recent.size > 6) this.#recent.delete(this.#recent.keys().next().value!);
	}
	warn(key: string, message: string): void {
		if (this.#closed || this.#shown.has(key)) return;
		this.cancel(key);
		this.#shown.add(key);
		// Bound request-scoped receipts without retaining question content or identifiers forever.
		if (this.#shown.size > 128) this.#shown.delete(this.#shown.values().next().value!);
		try { this.notify(clean(`Away: ${message}`), "warning"); }
		catch { /* Presentation failure must never prevent transport cleanup or alter answer authority. */ }
	}
	defer(key: string, message: string, relevant: () => boolean): void {
		if (this.#closed || this.#shown.has(key) || this.#deferred.has(key)) return;
		const timer = setTimeout(() => {
			this.#deferred.delete(key);
			if (!this.#closed && relevant()) this.warn(key, message);
		}, 10_000);
		timer.unref();
		this.#deferred.set(key, timer);
	}
	cancel(key: string): void {
		clearTimeout(this.#deferred.get(key));
		this.#deferred.delete(key);
	}
	recover(key: string): void { this.cancel(key); this.#shown.delete(key); }
	suppress(key: string): void { if (!this.#closed) { this.cancel(key); this.#shown.add(key); } }
	status(): string {
		const lines = [...this.#health].map(([area, state]) => `${area}: ${state}`);
		if (this.#recent.size) {
			lines.push("Recent diagnostics (not necessarily current failures):");
			for (const [code, count] of this.#recent) lines.push(`  ${diagnostics[code] ?? "Unclassified gateway failure"}${count > 1 ? ` (${count} occurrences)` : ""}`);
		}
		return lines.join("\n");
	}
	close(): void {
		this.#closed = true;
		for (const timer of this.#deferred.values()) clearTimeout(timer);
		this.#deferred.clear();
	}
}
