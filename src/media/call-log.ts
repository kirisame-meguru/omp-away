import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@oh-my-pi/pi-utils';
import type { DecisionReply } from '../decisions';

export type SpeechPhase = 'delta' | 'provider-final' | 'resolved-provider' | 'resolved-silence';
export type CallStage = 'joined' | 'ended' | 'voice-failed' | 'caller-unbound' | 'caller-stale' |
	'consult-started' | 'consult-finished' | 'consult-interrupted' | 'consult-failed' |
	'decision-started' | 'decision-reply' | 'decision-failed' | 'narration-appended' | 'readback-appended';
export interface CallLog {
	speech(role:'user'|'assistant',phase:SpeechPhase,text:string,meta?:{startMs?:number;endMs?:number;bound?:boolean}):void;
	event(stage:CallStage,reply?:DecisionReply['kind'],draft?:boolean):void;
	close():Promise<void>;
}
const MAX_BYTES=2*1024*1024, KEEP_CALLS=20, KEEP_MS=7*24*60*60*1000;
const owned=/^call-\d{8}T\d{9}Z-[a-f0-9-]{36}(?:\.active)?\.jsonl$/;
const stamp=(time:number)=>new Date(time).toISOString().replace(/[-:.]/g,'');
async function prune(directory:string) {
	const cutoff=`call-${stamp(Date.now()-KEEP_MS)}`;
	const files=(await fs.promises.readdir(directory,{withFileTypes:true}))
		.filter(entry=>entry.isFile() && owned.test(entry.name)).map(entry=>entry.name).sort();
	const completed=files.filter(name=>!name.endsWith('.active.jsonl'));
	const expired=new Set(completed.slice(0,Math.max(0,completed.length-KEEP_CALLS)));
	for(const name of files) if(name<cutoff) expired.add(name);
	await Promise.all([...expired].map(name=>fs.promises.rm(path.join(directory,name),{force:true})));
}

/** Speech stays in local files, never in centralized/telemetry log sinks or provider dumps. */
export async function openCallLog(directory:string,requestId:string,sessionId:string):Promise<CallLog|undefined> {
	if(process.env.OMP_AWAY_TRANSCRIPTS==='0') return;
	let warned=false;
	const warn=()=>{
		if(warned) return; warned=true;
		try {logger.warn('Away call transcript unavailable',{requestId})} catch { /* Logging is not call authority. */ }
	};
	try {
		await fs.promises.mkdir(directory,{recursive:true,mode:0o700});
		const info=await fs.promises.lstat(directory);
		if(!info.isDirectory() || info.isSymbolicLink()) throw Error('Invalid transcript directory');
		const callId=crypto.randomUUID(), started=Date.now();
		const file=path.join(directory,`call-${stamp(started)}-${callId}.jsonl`);
		const active=file.replace(/\.jsonl$/,'.active.jsonl');
		const opened=Promise.withResolvers<void>(), drained=Promise.withResolvers<void>();
		const stream=fs.createWriteStream(active,{flags:'wx',mode:0o600});
		let failed=false, closing:Promise<void>|undefined, bytes=0, sequence=0, limited=false;
		stream.once('open',()=>opened.resolve());
		stream.on('error',()=>{failed=true;warn();opened.reject(Error('Transcript unavailable'))});
		stream.once('close',()=>drained.resolve());
		await opened.promise;
		const write=(record:Record<string,unknown>,footer=false)=>{
			if(failed || (limited && !footer)) return;
			try {
				let line=JSON.stringify({seq:++sequence,at:new Date().toISOString(),elapsedMs:Date.now()-started,...record})+'\n';
				if(!footer && bytes+Buffer.byteLength(line)>MAX_BYTES-512) {
					limited=true;
					line=JSON.stringify({seq:sequence,kind:'limit',maxBytes:MAX_BYTES})+'\n';
				}
				bytes+=Buffer.byteLength(line); stream.write(line);
			} catch {failed=true;warn();stream.destroy()}
		};
		write({kind:'call',callId,requestId,sessionId});
		try {logger.info('Away call transcript',{callId,requestId,path:active})} catch { /* Local recording remains available. */ }
		return {
			speech(role,phase,text,meta) {
				if(closing || (role!=='user' && role!=='assistant') || typeof text!=='string' || !text) return;
				write({kind:'speech',role,phase,text:text.slice(0,8192),truncated:text.length>8192,
					startMs:meta?.startMs,endMs:meta?.endMs,bound:meta?.bound});
			},
			event(stage,reply,draft) {if(!closing) write({kind:'event',stage,reply,draft})},
			close() {
				return closing ??= (async()=>{
					try {
						write({kind:'closed',limited},true); stream.end(); await drained.promise;
						if(failed) return;
						await fs.promises.rename(active,file);
						await prune(directory);
						logger.info('Away call transcript closed',{callId,requestId,path:file,limited});
					} catch {warn();stream.destroy()}
				})();
			},
		};
	} catch {warn();return}
}
