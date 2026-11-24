import { expect, test } from 'bun:test';
import { liveContext } from '../src/media/context';

type Context = Parameters<typeof liveContext>[0];
const message = (id: string, role: string, content: unknown) => ({ type: 'message', id, message: { role, content } });
const text = (text: string) => ({ type: 'text', text });
function host(branch: unknown, name: unknown = 'Synthetic planning', cwd = '/example/pocket-notes'): Context {
	return { cwd, sessionManager: { getBranch() { return branch }, getSessionName() { return name } } } as unknown as Context;
}
const snapshot = (ctx: Context) => JSON.parse(liveContext(ctx));

test('grounds live voice in ordered current-branch user and visible assistant text', () => {
	const result = snapshot(host([
		message('u1', 'user', 'Build an offline notes app; do not deploy.'),
		message('a1', 'assistant', [text('The editor works.'), text('Storage is still pending.')]),
		message('u2', 'user', [text('Compare SQLite and JSON before asking for approval.')]),
	]));
	expect(result).toMatchObject({ source: 'current-branch', available: true, sessionName: 'Synthetic planning', project: 'pocket-notes', summary: null, truncated: false, missing: [] });
	expect(result.messages).toEqual([
		{ role: 'user', text: 'Build an offline notes app; do not deploy.', truncated: false },
		{ role: 'assistant', text: 'The editor works.\nStorage is still pending.', truncated: false },
		{ role: 'user', text: 'Compare SQLite and JSON before asking for approval.', truncated: false },
	]);
});

test('excludes tool payloads, reasoning, images, custom messages, and credential metadata', () => {
	const encoded = liveContext(host([
		message('u1', 'user', [text('Keep the app offline.'), { type: 'image', data: 'excluded-image', mimeType: 'image/png' }]),
		message('a1', 'assistant', [
			{ type: 'thinking', thinking: 'excluded-thinking' },
			{ type: 'reasoning', text: 'excluded-reasoning' },
			{ type: 'toolCall', name: 'read', arguments: { path: 'excluded-config-file' } },
			text('The storage choice remains open.'),
		]),
		message('t1', 'toolResult', [text('excluded-tool-result')]),
		message('s1', 'system', 'excluded-system-message'),
		message('c1', 'custom', 'excluded-custom-role'),
		{ type: 'custom_message', content: 'excluded-custom-message', display: true },
		{ type: 'custom', data: { secret: 'excluded-extension-state' } },
		{ type: 'credential_pin', credentialId: 'excluded-credential' },
		{ type: 'session_init', config: 'excluded-init-config' },
		{ type: 'branch_summary', summary: 'excluded-abandoned-branch' },
	]));
	expect(encoded).not.toContain('excluded-');
	expect(JSON.parse(encoded).messages.map((entry: { text: string }) => entry.text)).toEqual(['Keep the app offline.', 'The storage choice remains open.']);
});

test('uses only getBranch rather than all entries or another branch', () => {
	const manager = {
		branch: [message('u1', 'user', 'Current branch: keep local.')],
		getBranch() { return this.branch },
		getSessionName() { return 'Current branch' },
		getEntries() { throw Error('Must not inspect other branches') },
		getTree() { throw Error('Must not inspect other branches') },
	};
	expect(snapshot({ sessionManager: manager } as unknown as Context).messages).toEqual([{ role: 'user', text: 'Current branch: keep local.', truncated: false }]);
});

test('uses the latest compaction summary followed by its retained tail and subsequent messages', () => {
	const result = snapshot(host([
		message('obsolete', 'user', 'Obsolete requirement: deploy immediately.'),
		{ type: 'compaction', id: 'c1', summary: 'Superseded summary.', firstKeptEntryId: 'obsolete' },
		message('old', 'assistant', [text('Obsolete draft.')]),
		message('keep', 'user', 'Keep local instead.'),
		message('tail', 'assistant', [text('Waiting for approval.')]),
		{ type: 'compaction', id: 'c2', summary: 'We are building an offline notes app.', firstKeptEntryId: 'keep', details: { hidden: 'excluded-details' } },
		message('new', 'user', 'What remains unfinished?'),
	]));
	expect(result.summary).toEqual({ text: 'We are building an offline notes app.', truncated: false });
	expect(result.messages.map((entry: { text: string }) => entry.text)).toEqual(['Keep local instead.', 'Waiting for approval.', 'What remains unfinished?']);
	expect(JSON.stringify(result)).not.toMatch(/Obsolete|Superseded|excluded-details/);
	expect(result.truncated).toBe(false);
});

test('does not revive pre-compaction history when its retained-tail boundary is unavailable', () => {
	const result = snapshot(host([
		message('old', 'user', 'Old history must not leak.'),
		{ type: 'compaction', id: 'c1', summary: 'Current compacted task.', firstKeptEntryId: 'not-on-this-branch' },
		message('new', 'user', 'The current question.'),
	]));
	expect(result.summary.text).toBe('Current compacted task.');
	expect(result.messages.map((entry: { text: string }) => entry.text)).toEqual(['The current question.']);
	expect(result.missing).toContain('compaction-boundary-unavailable');
	expect(JSON.stringify(result)).not.toContain('Old history');
});

test('missing summary is explicit and never replaced with obsolete messages or provider payloads', () => {
	const result = snapshot(host([
		message('old', 'user', 'Obsolete task.'),
		{ type: 'compaction', id: 'c1', firstKeptEntryId: '', preserveData: { providerHistory: 'excluded-provider-payload' } },
	]));
	expect(result.available).toBe(false);
	expect(result.summary).toBeNull();
	expect(result.messages).toEqual([]);
	expect(result.missing).toContain('compaction-summary-unavailable');
	expect(JSON.stringify(result)).not.toMatch(/Obsolete|excluded-provider/);
});

test('a reset after compaction retires the old summary and prior dialogue', () => {
	const result = snapshot(host([
		{ type: 'compaction', id: 'c1', summary: 'Retired task.', firstKeptEntryId: '' },
		message('old', 'assistant', [text('Retired answer.')]),
		{ type: 'reset_boundary', id: 'reset' },
		message('new', 'user', 'Start a new synthetic task.'),
	]));
	expect(result.summary).toBeNull();
	expect(result.messages.map((entry: { text: string }) => entry.text)).toEqual(['Start a new synthetic task.']);
	expect(JSON.stringify(result)).not.toContain('Retired');
});

for (const manager of [undefined, {}, { getSessionName: () => 'Synthetic title only' }, { getBranch: () => { throw Error('excluded-private-error') } }]) {
	test(`missing or inaccessible branch capability is honest (${Object.keys(manager ?? {}).join(',') || 'absent'})`, () => {
		const result = snapshot({ sessionManager: manager } as unknown as Context);
		expect(result.available).toBe(false);
		expect(result.messages).toEqual([]);
		expect(result.summary).toBeNull();
		expect(result.missing).toContain('branch-unavailable');
		expect(JSON.stringify(result)).not.toContain('excluded-private-error');
	});
}

test('missing or throwing optional session-name capability does not discard available dialogue', () => {
	for (const getSessionName of [undefined, () => { throw Error('excluded-title-error') }]) {
		const result = snapshot({ sessionManager: { getBranch: () => [message('u1', 'user', 'The current task.')], getSessionName } } as unknown as Context);
		expect(result.available).toBe(true);
		expect(result.sessionName).toBeNull();
		expect(result.missing).toContain('session-name-unavailable');
		expect(result.messages[0].text).toBe('The current task.');
	}
});

test('empty, invalid, or non-visible branch content cannot masquerade as known task context', () => {
	for (const branch of [undefined, {}, [], [message('t1', 'toolResult', 'excluded-tool-only')], [null, { type: 'message', message: null }]]) {
		const result = snapshot(host(branch));
		expect(result.available).toBe(false);
		expect(result.messages).toEqual([]);
		expect(result.missing.length).toBeGreaterThan(0);
	}
});

test('project metadata includes only the basename for either path style', () => {
	for (const cwd of ['/example/private-parent/pocket-notes/', 'C:\\example\\private-parent\\pocket-notes\\']) {
		const encoded = liveContext(host([message('u1', 'user', 'Synthetic task.')], 'Planning', cwd));
		expect(JSON.parse(encoded).project).toBe('pocket-notes');
		expect(encoded).not.toContain('private-parent');
		expect(encoded).not.toContain('C:');
	}
});

test('bounds UTF-8 serialized size and keeps latest ordered excerpts with truncation indicators', () => {
	const branch = Array.from({ length: 120 }, (_, i) => message(`u${i}`, 'user', `${'界'.repeat(5000)} newest-${i}`));
	const encoded = liveContext(host(branch, '界'.repeat(20000)));
	const result = JSON.parse(encoded);
	expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(24 * 1024);
	expect(result.truncated).toBe(true);
	expect(result.messages.length).toBeGreaterThan(0);
	expect(result.messages.at(-1).text).toEndWith('newest-119');
	const indices = result.messages.map((entry: { text: string; truncated: boolean }) => {
		expect(entry.truncated).toBe(true);
		expect(Buffer.byteLength(entry.text, 'utf8')).toBeLessThanOrEqual(4096);
		expect(entry.text).not.toContain('\ufffd');
		return Number(entry.text.match(/newest-(\d+)$/)![1]);
	});
	expect(indices).toEqual([...indices].sort((a, b) => a - b));
});

test('accounts for JSON escaping and preserves Unicode scalar boundaries', () => {
	const encoded = liveContext(host(Array.from({ length: 50 }, (_, i) => message(`a${i}`, 'assistant', [text(('\u0000"\\😀').repeat(6000) + ` last-${i}`)]))));
	const result = JSON.parse(encoded);
	expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(24 * 1024);
	expect(result.messages.at(-1).text).toEndWith('last-49');
	for (const entry of result.messages) expect(entry.text.isWellFormed()).toBe(true);
	expect(result.truncated).toBe(true);
});

test('large summaries and many visible blocks stay bounded without losing the latest user turn', () => {
	const encoded = liveContext(host([
		{ type: 'compaction', id: 'c1', firstKeptEntryId: '', summary: '界'.repeat(60000) + ' Latest summary.' },
		message('a1', 'assistant', Array.from({ length: 500 }, (_, i) => text('界'.repeat(5000) + ` block-${i}`))),
		message('u1', 'user', 'Keep local; do not deploy.'),
	]));
	const result = JSON.parse(encoded);
	expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(24 * 1024);
	expect(result.summary.truncated).toBe(true);
	expect(result.messages.at(-1).text).toBe('Keep local; do not deploy.');
	expect(result.messages[0].text).toEndWith('block-499');
	expect(result.truncated).toBe(true);
});

test('never mutates the current branch, message blocks, or session state', () => {
	const content = Object.freeze([Object.freeze(text('Current visible answer.'))]);
	const branch = Object.freeze([
		Object.freeze({ type: 'message', id: 'a1', message: Object.freeze({ role: 'assistant', content }) }),
		Object.freeze(message('u1', 'user', 'The latest question.')),
	]);
	const before = JSON.stringify(branch);
	const ctx = Object.freeze(host(branch));
	expect(snapshot(ctx).messages.at(-1).text).toBe('The latest question.');
	expect(JSON.stringify(branch)).toBe(before);
});

test('retains the latest user request even when subsequent assistant text fills the budget', () => {
	const result = snapshot(host([
		message('u1', 'user', 'Keep local and preserve existing notes.'),
		...Array.from({ length: 100 }, (_, i) => message(`a${i}`, 'assistant', [text('Progress detail. '.repeat(1000) + ` update-${i}`)])),
	]));
	expect(result.messages[0]).toEqual({ role: 'user', text: 'Keep local and preserve existing notes.', truncated: false });
	expect(result.messages.at(-1).text).toEndWith('update-99');
	expect(result.truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(24 * 1024);
});
