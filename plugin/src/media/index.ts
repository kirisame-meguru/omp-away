import type { ExtensionContext, ExtensionLiveSession } from '@oh-my-pi/pi-coding-agent';
import type { QuestionCall } from '../decisions';
import { spawnPeer, type MediaPeer } from './peer';

export type VoiceContext=Pick<ExtensionContext,'cwd'|'startLive'> & {
	sessionManager:Pick<ExtensionContext['sessionManager'],'getSessionId'|'getSessionName'>;
	awayContext?:(content:string)=>Promise<void>;
};
export interface VoiceOptions {
	ctx: VoiceContext;
	call: QuestionCall;
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
	const context='<omp-away-plugin>\nThe user has answered your call. Continue this conversation in native live mode using the handset for audio. Discuss the pending question naturally; do not invent a form submission or require a scripted confirmation.\nCall completion: the call stays open until explicitly ended. When the user asks to hang up, the coding agent must use away_end_call with the requestId below. When the purpose is resolved, the realtime voice must first deliver the result or a brief closing response, then delegate a request to end this Away call to the coding agent, which must invoke away_end_call. Do not leave a completed call listening indefinitely. Do not end merely on a pause or while awaiting an answer. Ending a call does not submit a form.\n'+JSON.stringify({requestId:call.question.requestId,...call.question.context,html:call.question.html})+'\n</omp-away-plugin>';
	let live:ExtensionLiveSession|undefined,peer:MediaPeer|undefined;
	let closed=false,muted=false,cleanup:Promise<void>|undefined;
	let output=Promise.resolve(),queued=0;
	const ended=Promise.withResolvers<never>();
	void ended.promise.catch(()=>{});
	const abort=()=>{void close()};
	function close(reason?:Error):Promise<void> {
		if(cleanup) return cleanup;
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
		await call.takeOver();
		if(closed) return;
		await ctx.awayContext!(context);
		if(closed) return;
		live=await ctx.startLive!({
			sdpOffer,
			onPhase:phase=>{muted=phase==='muted'},
			onTranscript:transcript=>{if(!closed) options.onCaption?.(transcript.role,transcript.text,transcript.final)},
			onEnd:reason=>{void close(reason)},
		});
		if(closed) {await live.stop();return}
		await peer.answer(live.sdpAnswer,context);
		clearTimeout(timer);
	}
	try {await Promise.race([start(),ended.promise]);call.signal.throwIfAborted();if(closed) throw Error('Voice call ended')}
	catch(error) {await close(error instanceof Error?error:Error('Voice unavailable'));throw error}
	return {
		sendPcm(pcm) {if(closed) throw Error('Voice closed');if(!muted) peer!.sendPcm(pcm)},
		close:()=>close(),
	};
}
