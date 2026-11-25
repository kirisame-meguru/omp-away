import type { ExtensionContext, ExtensionLiveSession } from '@oh-my-pi/pi-coding-agent';
import { logger } from '@oh-my-pi/pi-utils';
import type { Clock, QuestionCall } from '../decisions';
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
const audioClock:Clock={
	now:()=>performance.now(),
	after(ms,callback){const timer=setTimeout(callback,Math.ceil(ms)).unref();return ()=>clearTimeout(timer)},
};

export async function openVoice(options:VoiceOptions,peerFactory:typeof spawnPeer=spawnPeer,clock:Clock=audioClock):Promise<VoiceCall> {
	const {ctx,call}=options;
	call.signal.throwIfAborted();
	if (typeof ctx.startLive !== 'function' || typeof ctx.awayContext !== 'function') throw Error('This host does not expose native remote live mode');
	const guidance=`The user has picked up an Away call about the pending question below. Pickup is not an answer. Continue naturally through handset audio; collect the user's decision and only the clarifications needed to act. The call is an input step in the existing task, not a replacement task or a reason to abandon ongoing work. A native Ask released for voice takeover is not evidence that the user cancelled the underlying work.

Resolve the question: use the user's actual spoken answer, including qualifications and changes of mind. Clarify material ambiguity or uncertain recognition instead of guessing. Do not require scripted confirmation, repeat an already answered question, or ask "shall I continue?" when the next step is already authorized. Preserve existing safety and approval requirements. Distinguish an answer, an explicit cancellation or deferral, and a request to end only the call. Silence, disconnection, and hangup are not consent or a completed answer.

When the user asks for information that needs the coding agent, the coding agent must return a normal final answer without invoking away_end_call or resolving the pending question in that answer turn. Native live returns that final answer to the realtime voice to speak naturally; tool-turn commentary is silent context, not a spoken answer. A handoff acknowledgment is not the answer.

The realtime voice requests call completion when the exchange is actually finished, after speaking any requested answer and handling necessary clarification, or when the user cancels or defers it. Delegate the outcome, any unresolved constraints, and the instruction to invoke away_end_call with the requestId below and continue work. Do not add a mandatory handoff acknowledgment, confirmation, or scripted goodbye. The coding agent must invoke that tool when completion is requested, not merely promise to end the call. Honor an explicit user hangup immediately. Otherwise, do not hang up merely because the coding agent has an answer ready, during ongoing clarification, or on a pause. Once the exchange is finished, do not keep the call open for implementation work.

Continue after hangup in the same task: if work was interrupted, resume from the last unfinished step and apply the answer. If the agent was idle waiting for this answer, start the work that the answer unblocks. Do not end the agent turn with only "call ended" while authorized work remains. Preserve other pending work and questions; do not restart completed steps or repeat external actions. Respect any explicit change of scope or instruction to stop. If no work remains, conclude briefly rather than inventing a task. If the answer still leaves a real blocker, continue independent authorized work and identify only the missing decision.

Question lifecycle: ending audio does not submit a form or mark a question answered. Carry the spoken outcome into the task context and use the existing supported question-resolution or withdrawal mechanism if the originating question is still pending. Do not fabricate a form submission, claim unconfirmed delivery, withdraw unrelated questions, or reopen a question already resolved by voice takeover.`;
	const context='<omp-away-plugin>\n'+guidance+'\n'+JSON.stringify({requestId:call.question.requestId,...call.question.context,html:call.question.html})+'\n</omp-away-plugin>';
	let live:ExtensionLiveSession|undefined,peer:MediaPeer|undefined;
	let closed=false,muted=false,cleanup:Promise<void>|undefined;
	let output=Promise.resolve(),queued=0;
	let nextOutputAt:number|undefined,cancelOutputWait:(()=>void)|undefined;
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
		cancelOutputWait?.();cancelOutputWait=undefined;
		ended.reject(reason??Error('Voice call ended'));
		cleanup=Promise.resolve().then(async()=>{
			await Promise.allSettled([live?.stop(),peer?.close()]);
		});
		try {options.onEnd(reason)} catch {}
		return cleanup;
	}
	const timer=setTimeout(()=>{void close(Error('Voice setup timed out'))},60000).unref();
	call.signal.addEventListener('abort',abort,{once:true});
	async function sendOutput(pcm:Uint8Array) {
		if(closed) return;
		while(nextOutputAt!==undefined && nextOutputAt>clock.now()) {
			const wait=Promise.withResolvers<void>();
			const cancel=clock.after(nextOutputAt-clock.now(),wait.resolve);
			cancelOutputWait=()=>{cancel();wait.resolve()};
			await wait.promise;
			cancelOutputWait=undefined;
			if(closed) return;
		}
		const now=clock.now();
		// Preserve the sample clock across small wakeup delays, but never dump a
		// backlog after a missed frame. Pace here: stdout can itself deliver bursts.
		nextOutputAt=nextOutputAt===undefined||now-nextOutputAt>=20?now+20:nextOutputAt+20;
		await options.onAudio(pcm);
	}
	async function start() {
		peer=peerFactory(pcm=>{
			if(closed) return;
			if(++queued>250) {void close(Error('Phone audio transport stalled'));return}
			output=output.then(()=>sendOutput(pcm)).catch(()=>{void close(Error('Phone audio unavailable'))}).finally(()=>{--queued});
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
		await peer.answer(live.sdpAnswer,context);
		stage='active';
		logger.debug('Away voice media active',{audioFrameMs:20});
		clearTimeout(timer);
	}
	try {await Promise.race([start(),ended.promise]);call.signal.throwIfAborted();if(closed) throw Error('Voice call ended')}
	catch(error) {await close(error instanceof Error?error:Error('Voice unavailable'));throw error}
	return {
		sendPcm(pcm) {if(closed) throw Error('Voice closed');if(!muted) peer!.sendPcm(pcm)},
		close:()=>close(),
	};
}
