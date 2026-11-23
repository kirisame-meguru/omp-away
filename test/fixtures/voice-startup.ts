import { mock } from 'bun:test';
import * as utils from '@oh-my-pi/pi-utils';
import * as sdk from '../../src/media/live-sdk.generated.mjs';

const [version, scenario = 'valid'] = process.argv.slice(2);
let peers = 0, answers = 0, pcm = 0, closedPeers = 0, closedTransports = 0, ended = 0;
const sent: unknown[] = [];
mock.module('@oh-my-pi/pi-utils', () => ({ ...utils, VERSION: version }));
mock.module('../../src/media/peer', () => ({
	spawnPeer() {
		++peers;
		return {
			offer: Promise.resolve('test offer'),
			async answer(value: string) { if (value !== 'test answer') throw Error('Wrong SDP'); ++answers },
			sendPcm(value: Uint8Array) { pcm += value.byteLength },
			async close() { ++closedPeers },
		};
	},
}));
mock.module('../../src/media/live-sdk.generated.mjs', () => ({
	...sdk,
	LiveTransport: class {
		sdpAnswer = 'test answer';
		async connect() { if (scenario === 'signaling-failed') throw Error('test signaling failure') }
		async send(value: unknown) { sent.push(value) }
		async close() { ++closedTransports }
	},
}));
// Load after boundary replacements; a static import would bind the real media launcher first.
const { openVoice } = await import('../../src/media');
const ctx = {
	sessionManager: { getSessionId: () => 'test-session' },
	modelRegistry: { authStorage: { oauth: { async access() {} }, limits: { async rotate() {} } } },
};
// Deliberately malformed runtime hosts cannot be represented by the SDK's static type.
if (scenario === 'missing-session') Object.assign(ctx.sessionManager, { getSessionId: () => undefined });
if (scenario === 'missing-session-api') Object.assign(ctx, { sessionManager: {} });
if (scenario === 'missing-auth') Object.assign(ctx.modelRegistry, { authStorage: undefined });
if (scenario === 'missing-access') Object.assign(ctx.modelRegistry.authStorage.oauth, { access: undefined });
if (scenario === 'missing-rotation') Object.assign(ctx.modelRegistry.authStorage.limits, { rotate: undefined });
let error: string | undefined;
try {
	const call = await openVoice({
		ctx: ctx as unknown as Parameters<typeof openVoice>[0]['ctx'],
		brief: 'Choose tea or coffee.', onTranscript() {}, onAudio() {}, onInterrupt() {}, onSpeechStarted() {},
		onEnd() { ++ended },
	});
	try { call.sendPcm(new Uint8Array(960)) } finally { await call.close(); await call.close() }
} catch (reason) { error = reason instanceof Error ? reason.message : 'Unknown failure' }
console.log(JSON.stringify({ error, peers, answers, pcm, closedPeers, closedTransports, ended, contextMessages: sent.length }));
