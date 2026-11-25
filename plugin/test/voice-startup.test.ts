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
test('call guidance returns requested answers through native voice before requesting hangup',async()=>{
	const result=await startup('19.1.1');
	expect(result.error).toBeUndefined();
	const guidance=result.contexts[0];
	expect(guidance).toContain('return a normal final answer without invoking away_end_call');
	expect(guidance).toContain('tool-turn commentary is silent context, not a spoken answer');
	expect(guidance).toContain('after speaking any requested answer');
	expect(guidance).toContain('Honor an explicit user hangup immediately');
	expect(guidance).toContain('Do not add a mandatory handoff acknowledgment');
	expect(guidance).not.toContain('must briefly acknowledge the outcome');
	expect(guidance).not.toContain('If the coding agent already has the outcome');
});
for(const scenario of ['missing-live','noncallable-live','missing-context','noncallable-context']) {
	test(`native live rejects ${scenario} before opening resources`,async()=>{
		const result=await startup('19.1.1',scenario);
		expect(result.error).toBe('This host does not expose native remote live mode');
		expect(result).toMatchObject({peers:0,closedPeers:0,closedTransports:0,ended:0,takeovers:0});
	});
}
test.each([
	['takeover-failed','takeover failed',0,'question-takeover'],
	['context-failed','context failed',0,'context-delivery'],
	['signaling-failed','signaling failed',0,'native-live'],
	['peer-answer-failed','peer answer failed',1,'peer-answer'],
])('native live releases resources on %s',async(scenario,message,closedTransports,stage)=>{
	const result=await startup('19.1.1',scenario);
	expect(result.error).toBe(message);
	expect(result).toMatchObject({peers:1,answers:0,pcm:0,closedPeers:1,closedTransports,ended:1});
	expect(result.diagnostics).toHaveLength(1);
	expect(result.diagnostics[0]).toMatchObject({stage,reason:'unclassified-error'});
	expect(JSON.stringify(result.diagnostics)).not.toContain(message);
	if(scenario==='takeover-failed') expect(result.contexts).toEqual([]);
	if(scenario==='context-failed') expect(result.order).not.toContain('live');
});
test('a session returned after cancellation is stopped without answering the peer',async()=>{
	const result=await startup('19.1.1','abort-during-start');
	expect(result.error).toBeDefined();
	expect(result).toMatchObject({peers:1,answers:0,closedPeers:1,closedTransports:1,ended:1});
});
test('context delivery timeout is retained categorically without logging call content',async()=>{
	const result=await startup('19.1.1','context-timeout');
	expect(result.diagnostics).toHaveLength(1);
	expect(result.diagnostics[0]).toMatchObject({stage:'context-delivery',reason:'Call context was not delivered'});
	expect(result.diagnostics[0].elapsedMs).toBeGreaterThanOrEqual(0);
	expect(JSON.stringify(result.diagnostics)).not.toContain('Choose a drink');
	expect(result.order).not.toContain('live');
});
