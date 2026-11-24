import { mock } from 'bun:test';
import * as utils from '@oh-my-pi/pi-utils';
import type { ExtensionLiveStartOptions } from '@oh-my-pi/pi-coding-agent';
import type { VoiceContext } from '../../src/media';
import type { QuestionCall } from '../../src/decisions';

const [version, scenario = 'valid'] = process.argv.slice(2);
let peers=0,answers=0,pcm=0,closedPeers=0,closedTransports=0,ended=0,takeovers=0;
const order:string[]=[],contexts:string[]=[],captions:unknown[]=[];
const life=new AbortController(), release=Promise.withResolvers<void>();
let startOptions:ExtensionLiveStartOptions|undefined;
let emitAudio:((pcm:Uint8Array)=>void)|undefined;
let audio=0;
mock.module('@oh-my-pi/pi-utils',()=>({...utils,VERSION:version}));
mock.module('../../src/media/peer',()=>({
	spawnPeer(onAudio:(pcm:Uint8Array)=>void) {
		++peers;order.push('peer');emitAudio=onAudio;
		return {
			offer:Promise.resolve('test offer'),
			async answer(value:string) {
				if(value!=='test answer') throw Error('Wrong SDP');
				if(scenario==='peer-answer-failed') throw Error('peer answer failed');
				++answers;order.push('answer');
			},
			sendPcm(value:Uint8Array){pcm+=value.byteLength},
			async close(){++closedPeers},
		};
	},
}));
// This test intentionally loads the media boundary after installing its process-isolated peer replacement.
const {openVoice}=await import('../../src/media');
const ctx:VoiceContext={
	cwd:'/example/project',
	sessionManager:{getSessionId:()=>'session',getSessionName:()=>'Synthetic task'},
	async awayContext(content) {
		order.push('context');
		if(scenario==='context-failed') throw Error('context failed');
		contexts.push(content);
	},
	async startLive(options) {
		order.push('live');startOptions=options;
		if(options.sdpOffer!=='test offer') throw Error('Wrong offer');
		if(scenario==='signaling-failed') {options.onEnd?.(Error('signaling failed'));throw Error('signaling failed')}
		if(scenario==='abort-during-start') {life.abort();await release.promise}
		return {sdpAnswer:'test answer',voice:'test',async stop(){++closedTransports;options.onEnd?.()}};
	},
};
const call:QuestionCall={
	signal:life.signal,
	question:{requestId:'request',toolCallId:'tool',html:'<form><label>Drink<select name="drink"><option value="tea">Tea</option><option value="coffee">Coffee</option></select></label></form>',
		context:{title:'Synthetic choice',blockedWork:'Choose a drink'},async submitConfirmed(){throw Error('Voice must not submit a form')}},
	async takeOver(){++takeovers;order.push('takeover');if(scenario==='takeover-failed') throw Error('takeover failed')},
	async withdraw(){throw Error('Startup must not withdraw a discussion result')},
	close(){life.abort()},
};
// Intentionally malformed host capability envelopes test runtime checks, not casts.
if(scenario==='missing-live') Object.assign(ctx,{startLive:undefined});
if(scenario==='noncallable-live') Object.assign(ctx,{startLive:true});
if(scenario==='missing-context') Object.assign(ctx,{awayContext:undefined});
if(scenario==='noncallable-context') Object.assign(ctx,{awayContext:true});
let error:string|undefined;
try {
	const opening=openVoice({ctx,call,onAudio(){++audio},onCaption(...caption){captions.push(caption)},onEnd(){++ended}});
	if(scenario==='abort-during-start') {
		await opening.catch(reason=>{error=reason instanceof Error?reason.message:'Unknown failure'});
		release.resolve();
		for(let i=0;i<10;i++) await Promise.resolve();
	} else {
		const voice=await opening;
		try {
			voice.sendPcm(new Uint8Array(960));
			startOptions?.onPhase?.('muted');voice.sendPcm(new Uint8Array(960));
			startOptions?.onPhase?.('listening');voice.sendPcm(new Uint8Array(960));
			startOptions?.onTranscript?.({role:'user',text:'Coffee',turn:1,final:true});
			emitAudio?.(new Uint8Array(960));
			for(let i=0;i<5;i++) await Promise.resolve();
		} finally {await voice.close();await voice.close()}
		startOptions?.onTranscript?.({role:'assistant',text:'Late',turn:1,final:true});
		emitAudio?.(new Uint8Array(960));
	}
} catch(reason) {error=reason instanceof Error?reason.message:'Unknown failure'}
finally {release.resolve()}
console.log(JSON.stringify({error,peers,answers,pcm,closedPeers,closedTransports,ended,takeovers,order,contexts,captions,audio}));
