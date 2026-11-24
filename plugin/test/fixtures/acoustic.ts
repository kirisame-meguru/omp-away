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
  let nativeFailed:((category:'native-model-capacity'|'native-model-failed')=>void)|undefined;
  pi.on('agent_end',event=>{
    const failed=event.messages.find(message=>message.role==='assistant'&&message.stopReason==='error');
    if(failed?.role==='assistant')
      nativeFailed?.(failed.errorMessage?.includes('turn_rate_limit_exceeded')?'native-model-capacity':'native-model-failed');
  });
  pi.on('tool_execution_end',event=>{if(event.toolName==='ask'&&!event.isError)nativeFinished?.()});
  pi.registerCommand('acousticprobe',{description:'Synthetic native Ask through dev-phone audio',handler:async(_,host)=>{
    const trace=process.env.OMP_AWAY_VOICE_TRACE;
    if(!trace)throw Error('Use test/acoustic.py');
    const encoded=process.env.OMP_AWAY_ACOUSTIC_FIXTURE??'{}';
    if(encoded.length>32768)throw Error('Oversize acoustic fixture');
    const fixture:unknown=JSON.parse(encoded);
    if(!fixture||typeof fixture!=='object'||Array.isArray(fixture))throw Error('Invalid acoustic fixture');
    const config=fixture as {form?:unknown;prompt?:unknown;taskContext?:unknown;openingWords?:unknown;openingAny?:unknown;observedWords?:unknown;durationSeconds?:unknown};
    if(Object.keys(config).some(key=>!['form','prompt','taskContext','openingWords','openingAny','observedWords','durationSeconds'].includes(key)))throw Error('Invalid acoustic fixture key');
    if(config.form!==undefined&&(typeof config.form!=='string'||!config.form.trim()||config.form.length>8192))throw Error('Invalid acoustic form');
    if(config.prompt!==undefined&&(typeof config.prompt!=='string'||config.prompt.length>4096))throw Error('Invalid acoustic prompt');
    if(config.taskContext!==undefined&&(typeof config.taskContext!=='string'||config.taskContext.length>8192))throw Error('Invalid synthetic task context');
    const durationSeconds=config.durationSeconds??180;
    if(typeof durationSeconds!=='number'||!Number.isInteger(durationSeconds)||durationSeconds<60||durationSeconds>900)throw Error('Invalid acoustic duration');
    const openingWords=config.openingWords??['tea','coffee'],openingAny=config.openingAny??(config.form===undefined?['other','own']:[]);
    function words(value:unknown,limit=32):value is string[]{return Array.isArray(value)&&value.length<=limit&&value.every(word=>typeof word==='string'&&/^[a-z']{1,32}$/.test(word))}
    const requestedWords=config.observedWords??[];
    if(!words(openingWords)||!openingWords.length||!words(openingAny)||!words(requestedWords,128))throw Error('Invalid acoustic observation words');
    const observedWords=new Set([...openingWords,...openingAny,...requestedWords,'submit']);
    const observe=(text:string)=>[...new Set((text.toLowerCase().match(/[\p{L}\p{N}']+/gu)??[]).filter(word=>observedWords.has(word)))];
    const prompt=config.form===undefined?nativePrompt:
      `This is an authorized synthetic acoustic integration test in a disposable host. Use the native ask tool once with exactly this form, without extra questions or defaults:\n${config.form}\nThe driver answers through real phone microphone audio. Do not answer or submit the form yourself. Once the native tool returns, respond only with the selected value. Do nothing else.`;
    const taskContext=config.taskContext?`Invented task facts for this disposable session only (not facts about the real repository):\n${config.taskContext}\nDo not invent progress, deployments, people, or facts absent from this context.\n\n`:'';
    const requestPrompt=taskContext+(config.prompt?`${prompt}\nSynthetic test context: ${config.prompt}`:prompt);
    void (async()=>{
    interface ResponseObservation {
      id:number;callerTurn:number;startedAt:number;finalAt:number;firstAudioAt:number;lastAudioAt:number;
      words:string[];wordCount:number;readback:number;interrupted:boolean;submitPrompts:number;
      category:'pending'|'answer'|'opening'|'readback'|'holding';
    }
    const state={messages:0,messageAt:0,readbacks:0,readbackAt:0,lastVoicedAt:0,micFrames:0,outFrames:0,marks:0,drains:0,
      responseSeq:0,assistantFinals:0,callerTurns:0,lastCallerFinalAt:0,holdingAcks:0,duplicateSubmitPrompt:false,responses:[] as ResponseObservation[],
      hotMicFrames:0,maxMicRms:0,submitted:0,delivery:'',values:{} as Record<string,unknown>,nativeEnded:false,ended:false,stop:false,errors:[] as string[]};
    let response:ResponseObservation|undefined;
    let pendingDesktop:{at:number;readback:number;opening:boolean}|undefined;
    function beginResponse():ResponseObservation|undefined {
      if(response)return response;
      if(state.responses.length>=64){
        if(!state.errors.includes('assistant-observation-limit'))state.errors.push('assistant-observation-limit');
        return;
      }
      const now=Date.now(),desktop=pendingDesktop;
      pendingDesktop=undefined;
      response={id:++state.responseSeq,callerTurn:state.callerTurns,startedAt:now,finalAt:0,firstAudioAt:0,lastAudioAt:0,
        words:[],wordCount:0,readback:desktop&&now>=desktop.at?desktop.readback:0,interrupted:false,submitPrompts:0,
        category:desktop?.opening?'opening':'pending'};
      state.responses.push(response);
      return response;
    }
    nativeFinished=()=>{state.nativeEnded=true};
    nativeFailed=category=>{if(!state.stop&&!state.nativeEnded&&!state.errors.includes(category))state.errors.push(category)};
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
      async runEphemeralTurn(options){
        if(!host.runEphemeralTurn)throw Error('Host side turns unavailable');
        return host.runEphemeralTurn(options);
      }};
    const runtimePromise=connected.promise.then(()=>connectRuntime({url:'https://example.invalid',desktopToken:'',stateDir:trace+'.state',confirmPair:async()=>false},
      code=>state.errors.push(code),{
        async voice(options){
          const voice=await openVoice({...options,
            onSpeechStarted(id,startedAt){
              // Keep an unfinished response's ownership for its late final.
              if(response&&!response.finalAt)response.interrupted=true;
              else response=undefined;
              pendingDesktop=undefined;state.callerTurns++;
              options.onSpeechStarted(id,startedAt);
            },
            onInterrupt(){
              if(response&&!response.finalAt)response.interrupted=true;
              else response=undefined;
              pendingDesktop=undefined;
              options.onInterrupt();
            },
            onTranscript(role,text,id){
              if(role==='user')state.lastCallerFinalAt=Date.now();
              options.onTranscript(role,text,id);
            },
            onCaption(role,text,final){
              if(role==='assistant'){
                // Native turn.done produces final=true; a partial caption is never completion.
                if(response?.finalAt)response=undefined;
                const current=beginResponse();
                if(current){
                  const words=text.toLowerCase().replaceAll('’',"'").match(/[\p{L}\p{N}']+/gu)??[];
                  current.wordCount=words.length;current.words=observe(text.replaceAll('’',"'"));
                  if(final){
                    current.finalAt=Date.now();state.assistantFinals++;
                    current.submitPrompts=text.match(/\bsubmit\s*\?/giu)?.length??0;
                    let prompts=0;
                    for(const observed of state.responses) if(observed.callerTurn===current.callerTurn)prompts+=observed.submitPrompts;
                    if(prompts>1){
                      state.duplicateSubmitPrompt=true;
                      if(!state.errors.includes('duplicate-submit-prompt'))state.errors.push('duplicate-submit-prompt');
                    }
                    const holding=words.join(' ');
                    if(holding==='okay'||holding==='ok'||holding==='got it'){
                      current.category='holding';state.holdingAcks++;
                      if(!state.errors.includes('standalone-holding-acknowledgement'))state.errors.push('standalone-holding-acknowledgement');
                    }else if(current.readback)current.category='readback';
                    else if(current.category!=='opening')current.category='answer';
                  }
                }
              }
              options.onCaption?.(role,text,final);
            },
          });
          return {...voice,async sendSpeakable(text,instruction=false){
            state.messages++;state.messageAt=Date.now();
            if(instruction){state.readbacks++;state.readbackAt=state.messageAt}
            // A new desktop response must not inherit an interrupted response
            // whose provider final never arrived.
            if(response?.interrupted)response=undefined;
            // Only this real desktop draft instruction can label a later response as a readback.
            pendingDesktop={at:state.messageAt,readback:instruction?state.readbacks:0,opening:state.messages===1};
            await voice.sendSpeakable(text,instruction);
          }};
        },
        async gateway(options){wire=options;let prefs:Preferences={away:false,delayMs:null};options.onRouting?.(prefs);return {
          async routing(patch={}){prefs={...prefs,...patch};options.onRouting?.(prefs);return prefs},
          async devices(){return ['fixture']},async pair(){throw Error('No enrollment')},async close(){},async ring(){throw Error('No production notifications')},
          async invalidate(){},
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
            if(Math.sqrt(energy/(pcm.length/2))>=64){
              const now=Date.now(),current=beginResponse();
              state.lastVoicedAt=now;quiet=0;voiced=true;
              if(current){current.firstAudioAt||=now;current.lastAudioAt=now}
            }else if(voiced)quiet++;
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
      void pi.sendUserMessage(requestPrompt).catch(()=>state.errors.push('native-prompt-failed'));
      const deadline=Date.now()+durationSeconds*1000;
      while(!state.ended&&!state.stop&&!state.errors.length&&Date.now()<deadline)await Bun.sleep(25);
      if(!state.ended)state.errors.push('conversation-incomplete');
    }catch(error){state.errors.push(error instanceof Error?error.name:'probe-error')}
    finally{
      await runtime?.close();unsubscribe?.();
      const deadline=Date.now()+5000;
      while((state.drains<state.marks||state.submitted===1&&!state.nativeEnded)&&Date.now()<deadline)await Bun.sleep(25);
      nativeFinished=undefined;nativeFailed=undefined;
      device?.write(Buffer.from([3]));await Bun.write(trace+'.result',JSON.stringify(state));
      server.stop();monitor.stop();process.exit(state.submitted===1&&state.nativeEnded&&!state.errors.length?0:1);
    }
    })().catch(()=>Bun.write(trace+'.startup-error','probe-start-failed'));
  }});
}
