import type { Socket } from 'bun';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { connectRuntime, type AskContext, type MobileRuntime } from '../../src/runtime/routing';
import { openVoice } from '../../src/media';
import { spawnPeer } from '../../src/media/peer';
import type { SecureDesktopOptions } from '../../src/secure-channel';
import type { PendingAsk } from '../../src/index';
import type { Preferences } from '../../src/decisions';
import nativePrompt from './acoustic-ask.md' with { type:'text' };

export default function acoustic(pi:ExtensionAPI) {
  // This fixture must never open or compete with the paired production gateway.
  for(const key of ['OMP_AWAY_URL','OMP_AWAY_TOKEN_FILE','OMP_AWAY_STATE_DIR','OMP_AWAY_TUNNEL_PYTHON']) delete process.env[key];
  let nativeFinished:((toolCallId:string)=>void)|undefined;
  let resumptionFinished:(()=>void)|undefined;
  let nativeFailed:((category:'native-model-capacity'|'native-model-failed')=>void)|undefined;
  const contextDeliveries=new Map<string,()=>void>();
  pi.on('message_end',event=>{
    const message=event.message;
    if(message.role!=='custom'||message.customType!=='omp-away:acoustic-context')return;
    const details=message.details;
    if(details&&typeof details==='object'&&'id' in details&&typeof details.id==='string')contextDeliveries.get(details.id)?.();
  });
  pi.on('agent_end',event=>{
    const failed=event.messages.find(message=>message.role==='assistant'&&message.stopReason==='error');
    if(failed?.role==='assistant')
      nativeFailed?.(failed.errorMessage?.includes('turn_rate_limit_exceeded')?'native-model-capacity':'native-model-failed');
    if(event.messages.some(message=>message.role==='assistant'&&message.stopReason!=='error'&&
      message.content.some(part=>part.type==='text'&&part.text.trim()==='synthetic-resumed')))resumptionFinished?.();
  });
  pi.on('tool_execution_end',event=>{if(event.toolName==='ask')nativeFinished?.(event.toolCallId)});
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
    const observedWords=new Set([...openingWords,...openingAny,...requestedWords]);
    const observe=(text:string)=>[...new Set((text.toLowerCase().match(/[\p{L}\p{N}']+/gu)??[]).filter(word=>observedWords.has(word)))];
    const prompt=config.form===undefined?nativePrompt:
      `This is an authorized synthetic acoustic integration test in a disposable host. Use the native ask tool once with exactly this form, without extra questions or defaults:\n${config.form}\nThe driver discusses the question through real phone microphone audio. Do not answer or submit the form yourself. Native live takeover will withdraw this Ask; continue the discussion naturally without claiming a canonical selection. Do not invoke Ask again.`;
    const taskContext=config.taskContext?`Invented task facts for this disposable session only (not facts about the real repository):\n${config.taskContext}\nDo not invent progress, deployments, people, or facts absent from this context.\n\n`:'';
    const requestPrompt=taskContext+(config.prompt?`${prompt}\nSynthetic test context: ${config.prompt}`:prompt);
    void (async()=>{
    interface ResponseObservation {
      id:number;callerTurn:number;startedAt:number;finalAt:number;firstAudioAt:number;lastAudioAt:number;
      words:string[];wordCount:number;interrupted:boolean;
      category:'pending'|'answer'|'opening';
    }
    const state={mode:'native-live',messages:0,messageAt:0,lastVoicedAt:0,micFrames:0,outFrames:0,marks:0,drains:0,
      responseSeq:0,assistantFinals:0,callerTurns:0,lastCallerFinalAt:0,responses:[] as ResponseObservation[],
      userTranscripts:{partials:0,finals:0,firstPartialAt:0,lastPartialAt:0,firstFinalAt:0,lastFinalAt:0},
      providerEvents:{} as Record<string,number>,
      hotMicFrames:0,maxMicRms:0,submitted:0,delivery:'',values:{} as Record<string,unknown>,
      offers:0,takeoverAttempts:0,takeovers:0,withdrawals:0,nativeEnds:0,contextMatched:false,contextAckAt:0,firstAudioAt:0,
      liveStarted:false,liveStops:0,closed:false,resumed:false,nativeEnded:false,ended:false,stop:false,errors:[] as string[]};
    let originatingAsk:PendingAsk|undefined,expectedContext:string|undefined;
    let response:ResponseObservation|undefined;
    let callerPending=false;
    function beginResponse():ResponseObservation|undefined {
      if(response)return response;
      if(state.responses.length>=64){
        if(!state.errors.includes('assistant-observation-limit'))state.errors.push('assistant-observation-limit');
        return;
      }
      const now=Date.now();
      response={id:++state.responseSeq,callerTurn:state.callerTurns+(callerPending?1:0),startedAt:now,finalAt:0,firstAudioAt:0,lastAudioAt:0,
        words:[],wordCount:0,interrupted:false,
        category:state.responses.length===0?'opening':'pending'};
      state.responses.push(response);
      return response;
    }
    nativeFinished=id=>{if(id===originatingAsk?.toolCallId){state.nativeEnded=true;state.nativeEnds++}};
    nativeFailed=category=>{if(!state.errors.includes(category))state.errors.push(category)};
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
    const monitor=Bun.serve({hostname:'127.0.0.1',port:19584,async fetch(req){
      if(req.method==='POST'&&new URL(req.url).pathname==='/stop'&&!state.stop){
        state.stop=true;
        if(originatingAsk)await wire?.onMessage('fixture',{type:'hangup',requestId:originatingAsk.requestId});
      }
      return Response.json(state);
    }});
    await Bun.write(trace+'.ready','ready');
    let unsubscribe:(()=>void)|undefined;
    let runtime:MobileRuntime|undefined;
    const ctx:AskContext={
      cwd:host.cwd,sessionManager:host.sessionManager,
      async startLive(options){
        if(typeof host.startLive!=='function')throw Error('Native live unavailable');
        if(!state.contextMatched||!state.contextAckAt)throw Error('Native live started before originating context acknowledgment');
        const live=await host.startLive(options);state.liveStarted=true;
        return {...live,async stop(){await live.stop();state.liveStops++}};
      },
      awayContext(content){
        state.contextMatched=!!expectedContext&&content.split('\n').at(-2)===expectedContext;
        if(!state.contextMatched)return Promise.reject(Error('Wrong originating question context'));
        const {promise,resolve,reject}=Promise.withResolvers<void>();
        const id=crypto.randomUUID();
        const timer=setTimeout(()=>{contextDeliveries.delete(id);reject(Error('Context delivery timeout'))},20000);
        contextDeliveries.set(id,()=>{clearTimeout(timer);contextDeliveries.delete(id);state.contextAckAt=Date.now();resolve()});
        try{
          pi.sendMessage({customType:'omp-away:acoustic-context',content,display:true,attribution:'agent',details:{id}},
            host.isIdle()?{triggerTurn:false}:{deliverAs:'aside',triggerTurn:false});
          state.messages++;state.messageAt=Date.now();
        }catch(error){clearTimeout(timer);contextDeliveries.delete(id);reject(error)}
        return promise;
      },
    };
    const runtimePromise=connected.promise.then(()=>connectRuntime({url:'https://example.invalid',desktopToken:'',stateDir:trace+'.state',confirmPair:async()=>false},
      code=>state.errors.push(code),{
        async voice(options){
          return openVoice({...options,
            onCaption(role,text,final){
              // Counts and timestamps only; never retain caller transcript content for diagnostics.
              if(role==='user'){
                const now=Date.now(),transcripts=state.userTranscripts;
                // Caller finals may arrive after the assistant has already begun replying.
                // Only the start of caller speech can interrupt the preceding response.
                if(!callerPending){
                  if(response&&!response.finalAt)response.interrupted=true;
                  else response=undefined;
                  callerPending=true;
                }
                if(final){transcripts.finals++;transcripts.firstFinalAt||=now;transcripts.lastFinalAt=now}
                else{transcripts.partials++;transcripts.firstPartialAt||=now;transcripts.lastPartialAt=now}
              }
              if(role==='user'&&final){
                state.callerTurns++;state.lastCallerFinalAt=Date.now();callerPending=false;
              }
              if(role==='assistant'){
                // Observe native transcripts; these are not scripted readback proofs.
                if(response?.finalAt)response=undefined;
                const current=beginResponse();
                if(current){
                  const words=text.toLowerCase().replaceAll('’',"'").match(/[\p{L}\p{N}']+/gu)??[];
                  current.wordCount=words.length;current.words=observe(text.replaceAll('’',"'"));
                  if(final){
                    current.finalAt=Date.now();state.assistantFinals++;
                    if(current.category!=='opening')current.category='answer';
                  }
                }
              }
              options.onCaption?.(role,text,final);
            },
          },(audio,failed)=>spawnPeer(audio,failed,category=>{
            if(typeof category==='string')state.providerEvents[category]=(state.providerEvents[category]??0)+1;
          }));
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
            state.firstAudioAt||=Date.now();
            if(!state.contextAckAt&&!state.errors.includes('audio-before-context-ack'))state.errors.push('audio-before-context-ack');
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
        state.offers++;
        if(originatingAsk){state.errors.push('unexpected-question');return}
        originatingAsk=ask;
        if(config.form!==undefined&&ask.html!==config.form){state.errors.push('wrong-native-form');return}
        expectedContext=JSON.stringify({requestId:ask.requestId,...ask.context,html:ask.html});
        runtime!.offer({...ask,
          async takeOver(id){
            state.takeoverAttempts++;
            if(!ask.takeOver)throw Error('Native takeover unavailable');
            const result=await ask.takeOver(id);if(result==='accepted')state.takeovers++;
            return result;
          },
          async withdraw(id,reason){
            state.withdrawals++;
            if(!ask.withdraw)throw Error('Native withdrawal unavailable');
            return ask.withdraw(id,reason);
          },
          async submitConfirmed(id,values,notes){
            state.submitted++;state.values=values;
            const result=await ask.submitConfirmed(id,values,notes);state.delivery=result;return result;
          },
        },ctx);
        void wire!.onMessage('fixture',{type:'join',requestId:ask.requestId,captions:true});
      });
      void pi.sendUserMessage(requestPrompt).catch(()=>state.errors.push('native-prompt-failed'));
      const deadline=Date.now()+durationSeconds*1000;
      while(!state.ended&&!state.stop&&!state.errors.length&&Date.now()<deadline)await Bun.sleep(25);
      if(!state.stop)state.errors.push('conversation-ended-without-requested-hangup');
    }catch(error){state.errors.push(error instanceof Error?error.name:'probe-error')}
    finally{
      await runtime?.close();state.closed=true;unsubscribe?.();
      if(state.stop&&!state.errors.length){
        resumptionFinished=()=>{state.resumed=true};
        void pi.sendUserMessage('Synthetic post-call resumption probe: respond only with synthetic-resumed. Do not call tools.').catch(()=>state.errors.push('resumption-failed'));
        const deadline=Date.now()+30000;
        while(!state.resumed&&!state.errors.length&&Date.now()<deadline)await Bun.sleep(25);
        if(!state.resumed)state.errors.push('resumption-not-observed');
      }
      const deadline=Date.now()+5000;
      while(state.drains<state.marks&&Date.now()<deadline)await Bun.sleep(25);
      nativeFinished=undefined;nativeFailed=undefined;resumptionFinished=undefined;
      device?.write(Buffer.from([3]));await Bun.write(trace+'.result',JSON.stringify(state));
      server.stop();monitor.stop();
      process.exit(state.closed&&state.resumed&&state.liveStops===1&&state.takeovers===1&&state.nativeEnds===1&&
        state.submitted===0&&state.contextMatched&&state.contextAckAt>0&&state.firstAudioAt>=state.contextAckAt&&
        state.callerTurns>0&&state.assistantFinals>0&&state.hotMicFrames>0&&state.outFrames>0&&!state.errors.length?0:1);
    }
    })().catch(()=>Bun.write(trace+'.startup-error','probe-start-failed'));
  }});
}
