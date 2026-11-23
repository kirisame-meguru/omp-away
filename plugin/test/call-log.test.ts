import { expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCallLog, type CallLog } from '../src/media/call-log';

test('bounded JSONL preserves a truncation marker and excludes unselected provider fields',async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),'away-log-limit-'));
	const log=await openCallLog(root,'request','session');
	if(!log) throw Error('Transcript setup failed');
	try {
		const meta={startMs:12,endMs:30,credential:'never-store-provider-payload'};
		log.speech('user','delta','a'.repeat(9000),meta);
		const text='\u{1f642}'.repeat(4096);
		for(let i=0;i<200;i++) log.speech('assistant','delta',text);
		await log.close();
		const [file]=await fs.readdir(root), saved=Bun.file(path.join(root,file));
		expect(saved.size).toBeLessThanOrEqual(2*1024*1024);
		const content=await saved.text();
		const rows=Bun.JSONL.parse(content) as {kind:string;text?:string;truncated?:boolean;startMs?:number;endMs?:number;limited?:boolean}[];
		expect(rows[1]).toMatchObject({kind:'speech',text:'a'.repeat(8192),truncated:true,startMs:12,endMs:30});
		expect(content).not.toContain(meta.credential);
		expect(rows.filter(row=>row.kind==='limit')).toHaveLength(1);
		expect(rows.at(-1)).toMatchObject({kind:'closed',limited:true});
	} finally {await log.close();await fs.rm(root,{recursive:true,force:true})}
});

test('retention removes only owned expired and excess completed calls, not recent active or unrelated files',async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),'away-log-retention-'));
	const name=(time:number,active=false)=>`call-${new Date(time).toISOString().replace(/[-:.]/g,'')}-${crypto.randomUUID()}${active?'.active':''}.jsonl`;
	const old=Date.now()-8*24*60*60*1000;
	const expired=name(old), abandoned=name(old,true), active=name(Date.now(),true);
	const recent=Array.from({length:21},(_,i)=>name(Date.now()-100_000+i));
	const unrelated='notes.jsonl';
	try {
		for(const file of [expired,abandoned,active,...recent,unrelated]) await Bun.write(path.join(root,file),'preserve unrelated data');
		const log=await openCallLog(root,'request','session');
		if(!log) throw Error('Transcript setup failed');
		await log.close();
		const files=await fs.readdir(root);
		expect(files).not.toContain(expired); expect(files).not.toContain(abandoned);
		expect(files).not.toContain(recent[0]); expect(files).not.toContain(recent[1]);
		for(const file of recent.slice(2)) expect(files).toContain(file);
		expect(files.filter(file=>file.startsWith('call-')&&!file.endsWith('.active.jsonl'))).toHaveLength(20);
		expect(await Bun.file(path.join(root,active)).text()).toBe('preserve unrelated data');
		expect(await Bun.file(path.join(root,unrelated)).text()).toBe('preserve unrelated data');
	} finally {await fs.rm(root,{recursive:true,force:true})}
});

test('transcript opt-out creates no speech files or directory',async()=>{
	const root=await fs.mkdtemp(path.join(os.tmpdir(),'away-log-disabled-'));
	const previous=process.env.OMP_AWAY_TRANSCRIPTS;
	let pending:Promise<CallLog|undefined>;
	try {
		// The flag is read synchronously, so restore it before yielding to other work.
		try {
			process.env.OMP_AWAY_TRANSCRIPTS='0';
			pending=openCallLog(path.join(root,'calls'),'request','session');
		} finally {
			if(previous===undefined) delete process.env.OMP_AWAY_TRANSCRIPTS;
			else process.env.OMP_AWAY_TRANSCRIPTS=previous;
		}
		expect(await pending).toBeUndefined();
		expect(await fs.readdir(root)).toEqual([]);
	} finally {await fs.rm(root,{recursive:true,force:true})}
});
