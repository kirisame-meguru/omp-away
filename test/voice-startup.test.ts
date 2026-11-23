import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

async function startup(version: string, scenario = 'valid') {
	// Separate module registries keep the simulated host version and transport doubles
	// from changing other suites, which test the real transport and trace implementation.
	const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/voice-startup.ts', import.meta.url)), version, scenario], {
		stdout: 'pipe', stderr: 'pipe',
		env: { ...process.env, OMP_AWAY_VOICE_TRACE: '' },
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw Error(`Startup fixture failed (${code}): ${stderr}`);
	return JSON.parse(stdout.trim());
}

for (const version of ['19.1.0', '19.1.1', '20.0.0', '99.0.0-dev']) {
	test(`voice opens and closes with compatible host APIs on ${version}`, async () => {
		const result = await startup(version);
		expect(result.error).toBeUndefined();
		expect(result).toMatchObject({ peers: 1, answers: 1, pcm: 960, closedPeers: 1, closedTransports: 1, ended: 1 });
		expect(result.contextMessages).toBeGreaterThanOrEqual(2);
	});
}
for (const scenario of ['missing-session', 'missing-session-api', 'missing-auth', 'missing-access', 'missing-rotation']) {
	test(`voice rejects ${scenario} before opening media resources`, async () => {
		const result = await startup('19.1.1', scenario);
		expect(result.error).toBe('The current desktop session cannot authenticate Codex voice');
		expect(result).toMatchObject({ peers: 0, closedPeers: 0, closedTransports: 0, ended: 0 });
	});
}
test('a compatible updated host still reports signaling failure and releases media resources', async () => {
	const result = await startup('19.1.1', 'signaling-failed');
	expect(result.error).toBe('Codex voice signaling failed; check the desktop Codex login and network');
	expect(result).toMatchObject({ peers: 1, answers: 0, pcm: 0, closedPeers: 1, closedTransports: 1, ended: 1 });
});
