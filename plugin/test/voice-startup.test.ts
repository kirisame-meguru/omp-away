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
	test(`native live uses capabilities rather than host version ${version}`,async()=>{
		const result=await startup(version);
		expect(result.error).toBeUndefined();
		expect(result).toMatchObject({peers:1,answers:1,pcm:1920,closedPeers:1,closedTransports:1,ended:1,takeovers:1,audio:1});
		expect(result.order).toEqual(['peer','takeover','context','live','answer']);
		expect(result.contexts).toHaveLength(1);
		expect(result.contexts[0]).toContain('Coffee');
		expect(result.contexts[0]).toContain('Choose a drink');
		expect(result.captions).toEqual([['user','Coffee',true]]);
	});
}
for(const scenario of ['missing-live','noncallable-live','missing-context','noncallable-context']) {
	test(`native live rejects ${scenario} before opening resources`,async()=>{
		const result=await startup('19.1.1',scenario);
		expect(result.error).toBe('This host does not expose native remote live mode');
		expect(result).toMatchObject({peers:0,closedPeers:0,closedTransports:0,ended:0,takeovers:0});
	});
}
test.each([
	['takeover-failed','takeover failed',0],
	['context-failed','context failed',0],
	['signaling-failed','signaling failed',0],
	['peer-answer-failed','peer answer failed',1],
])('native live releases resources on %s',async(scenario,message,closedTransports)=>{
	const result=await startup('19.1.1',scenario);
	expect(result.error).toBe(message);
	expect(result).toMatchObject({peers:1,answers:0,pcm:0,closedPeers:1,closedTransports,ended:1});
	if(scenario==='takeover-failed') expect(result.contexts).toEqual([]);
	if(scenario==='context-failed') expect(result.order).not.toContain('live');
});
test('a session returned after cancellation is stopped without answering the peer',async()=>{
	const result=await startup('19.1.1','abort-during-start');
	expect(result.error).toBeDefined();
	expect(result).toMatchObject({peers:1,answers:0,closedPeers:1,closedTransports:1,ended:1});
});
