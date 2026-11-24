import { expect, test } from 'bun:test';
import { setImmediate as tick } from 'node:timers/promises';
import { connectRuntime, type AskContext } from '../src/runtime/routing';
import type { SecureDesktopOptions } from '../src/secure-channel';

async function fixture(ring: (device: string, request: string) => Promise<void>) {
	let wire!: SecureDesktopOptions;
	const errors: string[] = [], attempts: string[] = [];
	const runtime = await connectRuntime({ url: 'https://example.invalid', desktopToken: '', stateDir: '', confirmPair: async () => false }, code => errors.push(code), {
		async gateway(options) {
			wire = options;
			return {
				async devices() { return ['phone-a', 'phone-b'] },
				async ring(device, request) { attempts.push(device); await ring(device, request) },
				async invalidate() {},
				async routing() { const next = { away: true, delayMs: null }; options.onRouting?.(next); return next },
				async sendControl() {}, async sendPcm() {}, async close() {}, async pair() { throw Error('unexpected enrollment') },
			};
		},
		async voice() { return { sendPcm() {}, async sendSpeakable() {}, async close() {} } },
	});
	await runtime.configure({ away: true });
	const ctx = { cwd: '/example/project', sessionManager: { getSessionId: () => 'test-session' }, modelRegistry: {} } as unknown as AskContext;
	runtime.offer({ requestId: 'request-a', toolCallId: 'tool-a', html: '<form><label><input type="radio" name="drink" value="tea" checked>Tea</label><label><input type="radio" name="drink" value="coffee">Coffee</label></form>', async submitConfirmed() { return 'accepted' } }, ctx);
	return { runtime, wire, errors, attempts };
}

test('one accepted invitation prevents another paired phone failure from reporting total failure', async () => {
	const accepted = Promise.withResolvers<void>();
	const f = await fixture(device => {
		if (device === 'phone-a') throw Error('retired push registration');
		return accepted.promise;
	});
	try {
		await tick();
		expect(f.attempts).toEqual(['phone-a', 'phone-b']);
		expect(f.errors).toEqual([]);
		accepted.resolve(); await tick();
		expect(f.errors).toEqual([]);
	} finally { accepted.resolve(); await f.runtime.close() }
});

test('all failed invitations still warn for an untouched pending request', async () => {
	const f = await fixture(async () => { throw Error('push unavailable') });
	try { await tick(); expect(f.errors).toEqual(['invite-unavailable']) }
	finally { await f.runtime.close() }
});

for (const action of ['join', 'silence', 'end', 'close'] as const) {
	test(`late push failures cannot warn after request ${action}`, async () => {
		const pending = Promise.withResolvers<void>();
		const f = await fixture(() => pending.promise);
		try {
			f.wire.onConnect?.('phone-b');
			if (action === 'join' || action === 'silence') await f.wire.onMessage('phone-b', { type: action, requestId: 'request-a' });
			else if (action === 'end') f.runtime.end('request-a');
			else await f.runtime.close();
			pending.reject(Error('late push failure')); await tick();
			expect(f.errors).toEqual([]);
		} finally { pending.resolve(); await f.runtime.close() }
	});
}
