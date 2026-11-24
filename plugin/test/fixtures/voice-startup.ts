import { mock, vi } from 'bun:test';
import * as utils from '@oh-my-pi/pi-utils';
import * as sdk from '../../src/media/live-sdk.generated.mjs';
import type { LiveClientMessage } from '../../src/media/protocol';

const [version, scenario = 'valid'] = process.argv.slice(2);
let peers = 0, answers = 0, pcm = 0, closedPeers = 0, closedTransports = 0, ended = 0;
const sent: LiveClientMessage[] = [];
let consumerReady = false, earlyContextMessages = 0;
let contextReads = 0, leaf = 'initial';
const branch = [{type:'message',id:'u1',message:{role:'user',content:'Build an offline notes app without deployment.'}}];
const contextChecks = {initialGrounded:false,updatedGrounded:false,unchangedNotResent:false,refreshCommentaryOnly:false,stopped:false};
const contextText = (messages: readonly LiveClientMessage[] = sent) => messages.map(message => message.type==='session.context.append'
	? message.content.map(part => part.type==='input_text' ? part.text : '').join('') : '').join('');
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
		async send(value: LiveClientMessage) { if (!consumerReady) ++earlyContextMessages; sent.push(value) }
		async close() { ++closedTransports }
	},
}));
// Load after boundary replacements; a static import would bind the real media launcher first.
const { openVoice } = await import('../../src/media');
const ctx = {
	sessionManager: { getSessionId: () => 'test-session' },
	modelRegistry: { authStorage: { oauth: { async access() {} }, limits: { async rotate() {} } } },
};
if (scenario === 'context-refresh') {
	vi.useFakeTimers();
	Object.assign(ctx.sessionManager,{
		getLeafId:()=>leaf,
		getSessionName:()=>'Synthetic notes task',
		getBranch:()=>{++contextReads;return branch},
	});
}
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
	try {
		consumerReady = true;
		await call.sendSpeakable('Choose tea or coffee.');
		call.sendPcm(new Uint8Array(960));
		if (scenario === 'context-refresh') {
			const opening=sent.findIndex(message=>message.type==='session.context.append' && message.channel==='speakable');
			const initialContext=contextText(sent.slice(0,opening));
			contextChecks.initialGrounded=opening>=0 && initialContext.includes('Build an offline notes app without deployment.') && !initialContext.includes('Recovery tests passed.');
			const initialMessages=sent.length;
			vi.advanceTimersByTime(1000);
			for(let i=0;i<20;i++) await Promise.resolve();
			contextChecks.unchangedNotResent=sent.length===initialMessages && contextReads===1;
			branch.push({type:'message',id:'a1',message:{role:'assistant',content:'Recovery tests passed.'}});
			leaf='updated';
			vi.advanceTimersByTime(1000);
			for(let i=0;i<20;i++) await Promise.resolve();
			contextChecks.updatedGrounded=contextText().includes('Recovery tests passed.') && contextReads===2;
			contextChecks.refreshCommentaryOnly=sent.slice(initialMessages).every(message=>message.type==='session.context.append' && message.channel==='commentary');
		}
	} finally {
		await call.close();await call.close();
		if (scenario === 'context-refresh') {
			const finalMessages=sent.length;
			leaf='after-close';vi.advanceTimersByTime(2000);
			for(let i=0;i<20;i++) await Promise.resolve();
			contextChecks.stopped=sent.length===finalMessages && contextReads===2;
		}
	}
} catch (reason) { error = reason instanceof Error ? reason.message : 'Unknown failure' }
finally { if (scenario === 'context-refresh') vi.useRealTimers() }
console.log(JSON.stringify({ error, peers, answers, pcm, closedPeers, closedTransports, ended, contextMessages: sent.length, earlyContextMessages, contextChecks }));
