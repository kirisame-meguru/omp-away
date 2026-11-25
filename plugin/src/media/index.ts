import type { ExtensionContext, ExtensionLiveSession } from '@oh-my-pi/pi-coding-agent';
import { logger } from '@oh-my-pi/pi-utils';
import type { QuestionCall } from '../decisions';
import { spawnPeer, type MediaPeer } from './peer';
import type { Language } from '../language';
import { liveContext } from './context';
import guidance from './prompts/away-call.md' with { type: 'text' };

export type VoiceContext=Pick<ExtensionContext,'cwd'|'startLive'|'runEphemeralTurn'> & {
	sessionManager:Pick<ExtensionContext['sessionManager'],'getSessionId'|'getSessionName'> & Partial<Pick<ExtensionContext['sessionManager'],'getBranch'>>;
	awayContext?:(content:string)=>Promise<void>;
};
export interface VoiceOptions {
	ctx: VoiceContext;
	call: QuestionCall;
	language?: Language;
	onCaption?(role:'user'|'assistant', text:string, final:boolean):void;
	onAudio(pcm:Uint8Array):void|Promise<void>;
	onEnd(reason?:Error):void;
}
export interface VoiceCall {
	sendPcm(pcm:Uint8Array):void;
	close():Promise<void>;
}

export async function openVoice(options:VoiceOptions,peerFactory:typeof spawnPeer=spawnPeer):Promise<VoiceCall> {
	const {ctx,call}=options;
	call.signal.throwIfAborted();
	if (typeof ctx.startLive !== 'function' || typeof ctx.awayContext !== 'function') throw Error('This host does not expose native remote live mode');
	const context='<omp-away-plugin>\n'+guidance+'\n'+JSON.stringify({requestId:call.question.requestId,...call.question.context,html:call.question.html,preferredLanguage:options.language})+'\n</omp-away-plugin>';
	// Keep the user's typed language and recent dialogue in the voice bootstrap, not in a
	// second coding-agent message. The helper excludes tool payloads and bounds UTF-8.
	const history=liveContext(ctx);
	let live:ExtensionLiveSession|undefined,peer:MediaPeer|undefined;
	let closed=false,muted=false,cleanup:Promise<void>|undefined;
	let output=Promise.resolve(),queued=0;
	let stage='peer-offer';
	const started=Date.now();
	const ended=Promise.withResolvers<never>();
	void ended.promise.catch(()=>{});
	const abort=()=>{void close()};
	function close(reason?:Error):Promise<void> {
		if(cleanup) return cleanup;
		// Keep diagnostics categorical: provider errors may contain private URLs or credentials.
		const knownReasons=[
			'Call context was not delivered','Session changed','Voice setup timed out',
			'A live session is already active','Media peer unavailable','Phone audio transport stalled',
			'Phone audio unavailable','Voice call ended',
			'Finish the current speech-to-text capture before starting live mode.',
		];
		logger.debug('Away voice lifecycle ended',{
			stage,elapsedMs:Date.now()-started,
			reason:reason ? (knownReasons.includes(reason.message)?reason.message:'unclassified-error')
				:call.signal.aborted?'question-aborted':'close-requested',
		});
		closed=true;clearTimeout(timer);call.signal.removeEventListener('abort',abort);
		ended.reject(reason??Error('Voice call ended'));
		cleanup=Promise.resolve().then(async()=>{
			await Promise.allSettled([live?.stop(),peer?.close()]);
		});
		try {options.onEnd(reason)} catch {}
		return cleanup;
	}
	const timer=setTimeout(()=>{void close(Error('Voice setup timed out'))},60000).unref();
	call.signal.addEventListener('abort',abort,{once:true});
	async function start() {
		peer=peerFactory(pcm=>{
			if(closed) return;
			if(++queued>250) {void close(Error('Phone audio transport stalled'));return}
			output=output.then(()=>closed?undefined:options.onAudio(pcm)).catch(()=>{void close(Error('Phone audio unavailable'))}).finally(()=>{--queued});
		},()=>{void close(Error('Media peer unavailable'))});
		const sdpOffer=await peer.offer;
		if(closed) return;
		// Release a native Ask before live delegation needs the same agent loop.
		// The phone call retains its route until the native live controller stops.
		stage='question-takeover';
		await call.takeOver();
		if(closed) return;
		stage='context-delivery';
		await ctx.awayContext!(context);
		if(closed) return;
		stage='native-live';
		live=await ctx.startLive!({
			sdpOffer,
			onPhase:phase=>{muted=phase==='muted'},
			onTranscript:transcript=>{if(!closed) options.onCaption?.(transcript.role,transcript.text,transcript.final)},
			onEnd:reason=>{void close(reason)},
		});
		if(closed) {await live.stop();return}
		stage='peer-answer';
		const withHistory=context+'\n'+history;
		const fits=Buffer.byteLength(JSON.stringify({type:'answer',sdp:live.sdpAnswer,context:withHistory}))<=65536;
		await peer.answer(live.sdpAnswer,fits?withHistory:context);
		stage='active';
		clearTimeout(timer);
	}
	try {await Promise.race([start(),ended.promise]);call.signal.throwIfAborted();if(closed) throw Error('Voice call ended')}
	catch(error) {await close(error instanceof Error?error:Error('Voice unavailable'));throw error}
	return {
		sendPcm(pcm) {if(closed) throw Error('Voice closed');if(!muted) peer!.sendPcm(pcm)},
		close:()=>close(),
	};
}
