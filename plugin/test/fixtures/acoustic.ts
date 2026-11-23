import type { Socket } from 'bun';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { connectRuntime, type AskContext, type MobileRuntime } from '../../src/runtime/routing';
import { openVoice } from '../../src/media';
import type { SecureDesktopOptions } from '../../src/secure-channel';
import type { PendingAsk } from '../../src/index';
import type { Preferences } from '../../src/decisions';
import nativePrompt from './acoustic-ask.md' with { type:'text' };

export default function acoustic(pi:ExtensionAPI) {
  // This fixture must never open or compete with the paired production gateway.
  for(const key of ['OMP_AWAY_URL','OMP_AWAY_TOKEN_FILE','OMP_AWAY_STATE_DIR','OMP_AWAY_TUNNEL_PYTHON']) delete process.env[key];
  let nativeFinished:(()=>void)|undefined;
  pi.on('tool_execution_end',event=>{if(event.toolName==='ask'&&!event.isError)nativeFinished?.()});
  pi.registerCommand('acousticprobe',{description:'Synthetic native Ask through dev-phone audio',handler:async(_,host)=>{
    const trace=process.env.OMP_AWAY_VOICE_TRACE;
    if(!trace)throw Error('Use test/acoustic.py');
    void (async()=>{
    const state={messages:0,messageAt:0,readbacks:0,lastVoicedAt:0,assistantWords:[] as string[],assistantWordCount:0,micFrames:0,outFrames:0,marks:0,drains:0,
      hotMicFrames:0,maxMicRms:0,submitted:0,delivery:'',values:{} as Record<string,unknown>,nativeEnded:false,ended:false,stop:false,errors:[] as string[]};
    nativeFinished=()=>{state.nativeEnded=true};
    let wire:SecureDesktopOptions|undefined, device:Socket<undefined>|undefined;
    let pending=Buffer.alloc(0), quiet=0, voiced=false;
    const connected=Promise.withResolvers<void>();
    const server=Bun.listen<undefined>({hostname:'127.0.0.1',port:19583,socket:{
      open(socket){if(device){socket.end();return}device=socket;connected.resolve()},
      data(_socket,chunk){
        pending=Buffer.concat([pending,chunk]);
        while(pending.length){
          const kind=pending[0];
          if(kind===1){
            if(pending.length<961)break;
            const pcm=pending.subarray(1,961),samples=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);let energy=0;
            for(let i=0;i<pcm.length;i+=2)energy+=samples.getInt16(i,true)**2;
            const rms=Math.sqrt(energy/(pcm.length/2));
            state.maxMicRms=Math.max(state.maxMicRms,Math.round(rms));if(rms>=800)state.hotMicFrames++;
            state.micFrames++;wire?.onPcm('fixture',pcm);pending=pending.subarray(961);
          }else{pending=pending.subarray(1);if(kind===2)state.drains++;else state.errors.push('phone-audio-failed')}
        }
      },
    }});
    const monitor=Bun.serve({hostname:'127.0.0.1',port:19584,fetch(req){
      if(req.method==='POST'&&new URL(req.url).pathname==='/stop')state.stop=true;
      return Response.json(state);
    }});
    await Bun.write(trace+'.ready','ready');
    let unsubscribe:(()=>void)|undefined;
    let runtime:MobileRuntime|undefined;
    const ctx:AskContext={cwd:host.cwd,sessionManager:host.sessionManager,modelRegistry:host.modelRegistry,
      async runEphemeralTurn(options){if(!host.runEphemeralTurn)throw Error('Host side turns unavailable');return host.runEphemeralTurn(options)}};
    const runtimePromise=connected.promise.then(()=>connectRuntime({url:'https://example.invalid',desktopToken:'',stateDir:trace+'.state',confirmPair:async()=>false},
      code=>state.errors.push(code),{
        async voice(options){
          const voice=await openVoice({...options,onCaption(role,text,final){
            if(role==='assistant'){
              const words=text.toLowerCase().match(/[\p{L}\p{N}']+/gu)??[];
              state.assistantWordCount=words.length;
              state.assistantWords=words.filter(word=>['coffee','tea','submit','options','ideas','lemonade','other','own'].includes(word));
            }
            options.onCaption?.(role,text,final);
          }});
          return {...voice,async sendSpeakable(text,instruction=false){
            state.messages++;state.messageAt=Date.now();if(instruction)state.readbacks++;
            state.assistantWords=[];state.assistantWordCount=0;
            await voice.sendSpeakable(text,instruction);
          }};
        },
        async gateway(options){wire=options;let prefs:Preferences={away:false,delayMs:null};options.onRouting?.(prefs);return {
          async routing(patch={}){prefs={...prefs,...patch};options.onRouting?.(prefs);return prefs},
          async devices(){return ['fixture']},async pair(){throw Error('No enrollment')},async close(){},async ring(){throw Error('No production notifications')},
          async sendControl(_device,message){
            if(message.type==='joined'||message.type==='transcript'){
              const body=Buffer.from(JSON.stringify(message)),packet=Buffer.alloc(5+body.length);
              packet[0]=4;packet.writeUInt32BE(body.length,1);packet.set(body,5);
              if(device!.write(packet)!==packet.length)throw Error('Caption bridge backpressure');
            }
            if(message.type==='ended')state.ended=true;
          },
          async sendPcm(_device,pcm){
            state.outFrames++;
            const samples=new DataView(pcm.buffer,pcm.byteOffset,pcm.byteLength);let energy=0;
            for(let i=0;i<pcm.length;i+=2)energy+=samples.getInt16(i,true)**2;
            if(Math.sqrt(energy/(pcm.length/2))>=64){state.lastVoicedAt=Date.now();quiet=0;voiced=true}else if(voiced)quiet++;
            const packet=Buffer.alloc(961);packet[0]=1;packet.set(pcm,1);
            if(device!.write(packet)!==packet.length)throw Error('Phone bridge backpressure');
            if(quiet===30&&state.marks<2){device!.write(Buffer.from([2]));state.marks++;voiced=false;quiet=0}
          },
        }},
      }));
    try{
      runtime=await runtimePromise;wire!.onConnect!('fixture');
      unsubscribe=pi.events.on('omp-away:pending-ask',payload=>{
        const ask=payload as PendingAsk;
        runtime!.offer({...ask,async submitConfirmed(id,values){
          state.submitted++;state.values=values;
          const result=await ask.submitConfirmed(id,values);state.delivery=result;return result;
        }},ctx);
        void wire!.onMessage('fixture',{type:'join',requestId:ask.requestId,captions:true});
      });
      void pi.sendUserMessage(nativePrompt).catch(()=>state.errors.push('native-prompt-failed'));
      const deadline=Date.now()+180000;
      while(!state.ended&&!state.stop&&!state.errors.length&&Date.now()<deadline)await Bun.sleep(25);
      if(!state.ended)state.errors.push('conversation-incomplete');
    }catch(error){state.errors.push(error instanceof Error?error.name:'probe-error')}
    finally{
      await runtime?.close();unsubscribe?.();
      const deadline=Date.now()+5000;
      while((state.drains<state.marks||state.submitted===1&&!state.nativeEnded)&&Date.now()<deadline)await Bun.sleep(25);
      nativeFinished=undefined;
      device?.write(Buffer.from([3]));await Bun.write(trace+'.result',JSON.stringify(state));
      server.stop();monitor.stop();process.exit(state.submitted===1&&state.nativeEnded&&!state.errors.length?0:1);
    }
    })().catch(()=>Bun.write(trace+'.startup-error','probe-start-failed'));
  }});
}
