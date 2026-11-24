import { readFileSync } from 'node:fs';
import { type as schema } from '@oh-my-pi/pi-ai';
import type { AgentSession, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { LiveSessionController } from '@oh-my-pi/pi-coding-agent/live/controller';
import { resolveLiveVoice } from '@oh-my-pi/pi-coding-agent/live/settings';
import type { QuestionCall } from '../decisions';
import { spawnPeer, type MediaPeer } from './peer';

const nativeInstructions = readFileSync(new URL('./prompts/live-instructions.md', import.meta.resolve('@oh-my-pi/pi-coding-agent/live/controller')), 'utf8');
export type VoiceContext=ExtensionContext & {awaySdk?:Pick<ExtensionAPI['pi'],'createAgentSession'|'SessionManager'|'settings'>};
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

export async function openVoice(options:VoiceOptions):Promise<VoiceCall> {
	const {ctx,call}=options;
	call.signal.throwIfAborted();
	if (!ctx.model) throw Error('No active model for the voice conversation');
	if (!ctx.awaySdk) throw Error('The host SDK is unavailable for the voice conversation');
	const {createAgentSession,SessionManager,settings}=ctx.awaySdk;
	const manager=SessionManager.inMemory(ctx.cwd);
	const snapshot=manager.captureState();
	manager.restoreState({...snapshot,entries:structuredClone(ctx.sessionManager.getBranch())});
	const context='<omp-away-plugin>\nThe user has answered your call about this pending question. Discuss it naturally. When the discussion resolves the question, withdraw it using withdraw_question, including the useful outcome for the originating conversation. Do not invent a form submission or require a scripted confirmation.\n'+JSON.stringify({requestId:call.question.requestId,...call.question.context,html:call.question.html})+'\n</omp-away-plugin>';
	manager.appendCustomMessageEntry('omp-away:call',context,false);
	let session:AgentSession|undefined,live:LiveSessionController|undefined,peer:MediaPeer|undefined;
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
			await Promise.allSettled([live?.stop(),peer?.close(),session?.abort()]);
			await session?.dispose();
		});
		try {options.onEnd(reason)} catch {}
		return cleanup;
	}
	const timer=setTimeout(()=>{void close(Error('Voice setup timed out'))},60000).unref();
	call.signal.addEventListener('abort',abort,{once:true});
	async function start() {
		const created=await createAgentSession({
			cwd:ctx.cwd,model:ctx.model,modelRegistry:ctx.modelRegistry,settings,
			credentialSourceSessionId:ctx.sessionManager.getSessionId(),
			sessionManager:manager,systemPrompt:ctx.getSystemPrompt(),
			bindProcessState:false,disableExtensionDiscovery:true,
			agentId:`Away-${crypto.randomUUID()}`,enableIrc:false,
			customTools:[{
				name:'withdraw_question',label:'Withdraw question',
				loadMode:'essential',approval:'read',
				description:'Withdraw the question being discussed. Include the conversation outcome and any user decisions in reason.',
				parameters:schema({reason:'string'}),
				async execute(_id,args) {
					const result=await call.withdraw(args.reason);
					return {content:[{type:'text' as const,text:result==='accepted'?'Question withdrawn.':'Question is no longer available.'}],details:{result}};
				},
			}],
		});
		session=created.session;
		if(closed) {await session.dispose();return}
		peer=spawnPeer(pcm=>{
			if(closed) return;
			if(++queued>250) {void close(Error('Phone audio transport stalled'));return}
			output=output.then(()=>closed?undefined:options.onAudio(pcm)).catch(()=>{void close(Error('Phone audio unavailable'))}).finally(()=>{--queued});
		},()=>{void close(Error('Media peer unavailable'))});
		const sdpOffer=await peer.offer;
		if(closed) return;
		live=new LiveSessionController({
			session,sdpOffer,voice:resolveLiveVoice(session.settings),
			instructions:nativeInstructions+'\n'+context.replaceAll('{{','{ {'),
			extractAssistantText:message=>message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n'),
			callbacks:{
				onPhase:phase=>{muted=phase==='muted'},
				onLevels(){},
				onTranscript:transcript=>{if(!closed&&transcript) options.onCaption?.(transcript.role,transcript.text,transcript.final)},
				onTerminal:reason=>{void close(reason)},
			},
		});
		await live.start();
		if(closed) return;
		if(!live.sdpAnswer) throw Error('Missing live SDP answer');
		await peer.answer(live.sdpAnswer);
		clearTimeout(timer);
	}
	try {await Promise.race([start(),ended.promise]);call.signal.throwIfAborted();if(closed) throw Error('Voice call ended')}
	catch(error) {await close(error instanceof Error?error:Error('Voice unavailable'));throw error}
	return {
		sendPcm(pcm) {if(closed) throw Error('Voice closed');if(!muted) peer!.sendPcm(pcm)},
		close:()=>close(),
	};
}
