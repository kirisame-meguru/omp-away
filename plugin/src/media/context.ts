import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { posix, win32 } from 'node:path';

type Context = Pick<ExtensionContext, 'sessionManager'> & { cwd?: string };
interface Excerpt { text: string; truncated: boolean }
interface Message extends Excerpt { role: 'user' | 'assistant' }
interface Snapshot {
	source: 'current-branch';
	available: boolean;
	sessionName: string | null;
	project: string | null;
	summary: Excerpt | null;
	messages: Message[];
	truncated: boolean;
	missing: string[];
}
const MAX_BYTES = 24 * 1024;
const EXCERPT_BYTES = 4096;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep the newest text, bounding JSON escaping as well as UTF-8 bytes. */
function excerpt(value: string, limit = EXCERPT_BYTES): Excerpt {
	// A suffix of at most `limit` UTF-16 units bounds every temporary encoding.
	const offset = Math.max(0, value.length - limit);
	const tail = value.slice(offset);
	function boundary(index: number): number {
		const unit = tail.charCodeAt(index);
		return unit >= 0xdc00 && unit <= 0xdfff ? index + 1 : index;
	}
	let low = 0, high = tail.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (Buffer.byteLength(JSON.stringify(tail.slice(boundary(middle))), 'utf8') <= limit) high = middle;
		else low = middle + 1;
	}
	const start = boundary(low);
	return { text: tail.slice(start), truncated: offset + start > 0 };
}

function visibleMessage(entry: unknown): Message | undefined {
	if (!record(entry) || entry.type !== 'message' || !record(entry.message)) return;
	const { role, content } = entry.message;
	if (role !== 'user' && role !== 'assistant') return;
	let result: Excerpt | undefined;
	if (typeof content === 'string') result = excerpt(content);
	else if (Array.isArray(content)) {
		// Walk backwards without joining unbounded or non-text payloads.
		for (let i = content.length - 1; i >= 0; i--) {
			const block: unknown = content[i];
			if (!record(block) || block.type !== 'text' || typeof block.text !== 'string' || !block.text) continue;
			const part = excerpt(block.text);
			const joined = result ? excerpt(`${part.text}\n${result.text}`) : part;
			result = { text: joined.text, truncated: joined.truncated || part.truncated || (result?.truncated ?? false) };
			if (result.truncated) break;
		}
	}
	if (!result?.text.trim()) return;
	return { role, ...result };
}

/** Read-only visible context from the active branch; never loads files or provider replay data. */
export function liveContext(ctx: Context): string {
	const snapshot: Snapshot = {
		source: 'current-branch', available: false, sessionName: null, project: null,
		summary: null, messages: [], truncated: false, missing: [],
	};
	const manager = ctx.sessionManager;
	try {
		const name: unknown = typeof manager?.getSessionName === 'function' ? manager.getSessionName() : undefined;
		if (typeof name === 'string' && name.trim() && !/[\\/\u0000-\u001f\u007f]|^[A-Za-z]:/.test(name)) {
			const label = excerpt(name.trim(), 256);
			snapshot.sessionName = label.text;
			snapshot.truncated ||= label.truncated;
		}
	} catch { /* Optional host metadata must not prevent access to visible dialogue. */ }
	if (snapshot.sessionName === null) snapshot.missing.push('session-name-unavailable');
	if (typeof ctx.cwd === 'string') {
		const name = (ctx.cwd.includes('\\') ? win32 : posix).basename(ctx.cwd);
		if (name && name !== '.' && name !== '..' && !/[\\/:\u0000-\u001f\u007f]/.test(name)) {
			const label = excerpt(name, 256);
			snapshot.project = label.text;
			snapshot.truncated ||= label.truncated;
		}
	}
	let branch: unknown;
	try {
		if (typeof manager?.getBranch !== 'function') throw Error('missing-capability');
		branch = manager.getBranch();
	} catch {
		snapshot.missing.push('branch-unavailable');
		return JSON.stringify(snapshot);
	}
	if (!Array.isArray(branch)) {
		snapshot.missing.push('branch-invalid');
		return JSON.stringify(snapshot);
	}
	let start = 0;
	// SDK branch order is root -> leaf. A newer reset supersedes compaction;
	// otherwise its latest summary replaces the prefix before firstKeptEntryId.
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry: unknown = branch[i];
		if (!record(entry)) continue;
		if (entry.type === 'reset_boundary') { start = i + 1; break }
		if (entry.type !== 'compaction') continue;
		start = i + 1;
		if (typeof entry.summary === 'string' && entry.summary.trim()) {
			snapshot.summary = excerpt(entry.summary);
			snapshot.truncated ||= snapshot.summary.truncated;
		} else snapshot.missing.push('compaction-summary-unavailable');
		if (entry.firstKeptEntryId !== '') {
			const kept = typeof entry.firstKeptEntryId === 'string'
				? branch.findIndex((candidate: unknown) => record(candidate) && candidate.id === entry.firstKeptEntryId)
				: -1;
			if (kept >= 0 && kept < i) start = kept;
			else snapshot.missing.push('compaction-boundary-unavailable');
		}
		break;
	}
	const selected: { index: number; message: Message }[] = [];
	// Reserve the newest user request even if many later assistant messages
	// exhaust the budget. Any resulting history gap is marked as truncated.
	let latestUser = -1;
	for (let i = branch.length - 1; i >= start; i--) {
		const entry: unknown = branch[i];
		if (!record(entry) || !record(entry.message) || entry.message.role !== 'user') continue;
		const message = visibleMessage(entry);
		if (!message) continue;
		latestUser = i;
		selected.push({ index: i, message });
		snapshot.messages.push(message);
		snapshot.truncated ||= message.truncated;
		break;
	}
	// false is longer than true in JSON: later availability/truncation updates
	// cannot increase this envelope. Each additional array separator is counted.
	let remaining = MAX_BYTES - Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
	for (let i = branch.length - 1; i >= start; i--) {
		if (i === latestUser) continue;
		const message = visibleMessage(branch[i]);
		if (!message) continue;
		const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8') + (selected.length ? 1 : 0);
		if (bytes > remaining) { snapshot.truncated = true; break }
		remaining -= bytes;
		selected.push({ index: i, message });
		snapshot.truncated ||= message.truncated;
	}
	selected.sort((a, b) => a.index - b.index);
	snapshot.messages = selected.map(entry => entry.message);
	snapshot.available = snapshot.summary !== null || snapshot.messages.length > 0;
	if (!snapshot.available) snapshot.missing.push(branch.length ? 'no-visible-text' : 'branch-empty');
	return JSON.stringify(snapshot);
}
