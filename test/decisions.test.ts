import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DecisionCoordinator, loadPreferences, savePreferences, type DecisionCall, type DecisionReply, type SideContext } from "../src/decisions";
import type { PendingAsk } from "../src";

const html = `<form><input type="hidden" name="rev" value="r4"><label for="target">Release lane</label><select name="lane" id="target" required><option value="d" selected>Development</option><option value="p">Production</option><option value="x" disabled>Retired</option></select><label for="n">Replicas</label><input id="n" name="count" type="number" value="1" min="1" max="4" required></form>`;
const extraction = (lane: unknown = "p", count: unknown = 3) => JSON.stringify({fields:[{name:"lane",value:lane,evidence:"Production"},{name:"count",value:count,evidence:"three"}]});
const proposal = "My answer is Production with three replicas.";
function fixture() {
	let now = 100, seq = 0;
	const jobs = new Map<number, { time: number; callback(): void }>();
	const invites: string[] = [], errors: string[] = [], writes: unknown[] = [], prompts: string[] = [];
	let reply: (prompt: string, signal:AbortSignal) => string | Promise<string> = p => p.includes("\"utterance\"") ? extraction() : "The release is waiting for a lane and replica count.";
	const ctx: SideContext = { async runEphemeralTurn(opt) {
		expect(opt.tools).toBe(false); expect(opt.signal).toBeInstanceOf(AbortSignal);
		prompts.push(opt.promptText);
		return { replyText: await reply(opt.promptText,opt.signal), assistantMessage: {stopReason:"stop"} };
	} };
	const core = new DecisionCoordinator({invite: id => { invites.push(id); }, error: code => errors.push(code), clock:{now:()=>now, after(ms, callback) { const id = ++seq; jobs.set(id,{time:now+ms,callback}); return () => { jobs.delete(id); }; }}});
	const ask = (id: string): PendingAsk => ({ requestId:id,toolCallId:`tool-${id}`,html,async submitConfirmed(id,values){writes.push([id,values]);return "accepted";} });
	return { core, invites, writes, prompts, errors, ctx, ask, offer:(id:string)=>core.offer(ask(id),ctx,"project"), setReply(fn:typeof reply){reply=fn;}, advance(ms:number){ now+=ms; for (const [key,job] of jobs) if (job.time<=now) { jobs.delete(key); job.callback(); } } };
}
let item = 0;
function speak(call: DecisionCall, text: string) { const id=`u${++item}`; call.speechStarted(id); return call.speechFinished(id,text); }
function readback(reply: DecisionReply) {
	if (reply.kind !== "say" || !reply.mark) throw Error("Expected a marked readback");
	if (!reply.confirmationPhrase || !reply.text.endsWith(`Your words are ${reply.confirmationPhrase.split(" ").slice(-4).join(" ")}.`)) throw Error("Missing spoken tail challenge");
	return {mark:reply.mark,phrase:reply.confirmationPhrase,text:reply.text};
}
test("disabled, delayed and immediate routes ring at most once without expiring Ask", () => {
	const f=fixture(); f.offer("quiet"); f.advance(86_400_000); expect(f.invites).toEqual([]);
	f.core.silence("quiet"); f.core.configure({away:false,delayMs:500}); f.offer("late"); f.advance(499); expect(f.invites).toEqual([]);
	f.advance(1); expect(f.invites).toEqual(["late"]); f.core.configure({away:true,delayMs:null}); f.offer("now"); expect(f.invites).toEqual(["late","now"]);
	f.advance(86_400_000); expect(f.core.list().map(x=>x.requestId)).toEqual(["quiet","late","now"]); f.core.close();
});
test("local completion cancels notification and permanently revokes stale offer within generation", () => {
	const f=fixture(); f.core.configure({away:false,delayMs:10}); f.offer("A"); const a=f.core.join("A")!; f.core.end("A");
	expect(a.signal.aborted).toBe(true); expect(f.offer("A")).toBe(false); expect(f.core.join("A")).toBeUndefined(); f.advance(11); expect(f.invites).toEqual([]);
	f.core.close(); expect(f.offer("B")).toBe(false);
});
test("missed invites and hanging up preserve silenced inbox item; fresh join has no old draft", async () => {
	const f=fixture(); f.offer("A"); f.core.silence("A"); const c=f.core.join("A")!; await c.brief(); const r=readback(await speak(c,proposal)); c.close();
	f.core.configure({away:true,delayMs:1}); f.advance(1_000_000); expect(f.invites).toEqual([]); expect(f.core.list()[0]?.question).toContain("Release lane");
	const next=f.core.join("A")!; next.played(r.mark); expect((await speak(next,r.phrase)).kind).not.toBe("accepted"); expect(f.writes).toEqual([]); f.core.close();
});
test("only an uninterrupted completed readback and its fresh affirmative can submit; replay is inert", async () => {
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); const first=readback(await speak(c,proposal));
	expect(first.text).toContain("Production"); expect(first.text).toContain("3"); c.speechStarted("early"); c.played(first.mark);
	expect((await c.speechFinished("early",first.phrase)).kind).not.toBe("accepted"); const second=readback(await speak(c,"Repeat the readback"));
	c.played(first.mark); expect((await speak(c,second.phrase)).kind).not.toBe("accepted"); const third=readback(await speak(c,"Repeat the readback"));
	c.played(third.mark); expect((await speak(c,"Yes, that sounds interesting.")).kind).not.toBe("accepted"); expect(f.writes).toEqual([]);
	const final=readback(await speak(c,"Repeat the readback")); c.played(final.mark); c.speechStarted("final"); const submit=c.speechFinished("final",final.phrase);
	expect((await c.speechFinished("final",final.phrase)).kind).not.toBe("accepted"); expect((await submit).kind).toBe("accepted"); expect(f.writes).toEqual([["A",{rev:"r4",lane:"p",count:3}]]); f.core.close();
});
test("correction invalidates its predecessor; clarification and late ASR must not answer", async () => {
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); const old=readback(await speak(c,proposal)); c.played(old.mark);
	f.setReply(()=>extraction("p",2).replace('"three"','"two"')); const current=readback(await speak(c,"My answer is Production with two replicas.")); c.played(current.mark);
	expect((await c.speechFinished("missing-start",current.phrase)).kind).not.toBe("accepted"); expect((await speak(c,old.phrase)).kind).not.toBe("accepted");
	const repeat=readback(await speak(c,"Repeat the readback")); c.played(repeat.mark); f.setReply(()=>"Production has a rollback plan."); expect(await c.consult("Why use Production?" )).toContain("rollback");
	expect((await speak(c,repeat.phrase)).kind).not.toBe("accepted"); expect(f.writes).toEqual([]); f.core.close();
});
test.each([extraction("x"),extraction("p",5),extraction("p","3"),extraction().replace("Production","unstated"),JSON.stringify({fields:[{name:"lane",value:"d",evidence:"Production"}]}),"not json"])("malformed, incomplete or ungrounded extraction cannot arm a draft: %s", async bad=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); f.setReply(()=>bad);
	const reply=await speak(c,proposal); expect(reply.kind === "say" && !!reply.mark).toBe(false); expect(f.writes).toEqual([]); f.core.close();
});
test("pending extraction cannot resurrect a draft after desktop end or hangup", async () => {
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); const result=Promise.withResolvers<string>(); f.setReply(()=>result.promise);
	const pending=speak(c,proposal); f.core.end("A"); result.resolve(extraction()); expect((await pending).kind).toBe("stale"); expect(f.core.list()).toEqual([]); expect(f.writes).toEqual([]);
});
test("provider no-result, empty, and length stop do not create rationale; keep the native Ask", async () => {
	for(const ctx of [{runEphemeralTurn:async()=>{throw Error("private error");}}, {runEphemeralTurn:async()=>({replyText:"",assistantMessage:{stopReason:"stop"}})}, {runEphemeralTurn:async()=>({replyText:"partial",assistantMessage:{stopReason:"length"}})}]) {
		const f=fixture(); f.core.offer(f.ask("A"),ctx,"project"); await expect(f.core.join("A")!.brief()).rejects.toThrow("brief-unavailable"); expect(f.core.list()).toHaveLength(1); expect(f.errors).not.toContain("private error"); f.core.close();
	}
});
test("preferences survive a new process without carrying private request state",async()=>{
	const dir=await mkdtemp(join(tmpdir(),"away-prefs-")); try { const path=join(dir,"routing.json"); expect(await loadPreferences(path)).toEqual({away:false,delayMs:null}); await savePreferences(path,{away:true,delayMs:1200}); expect(await loadPreferences(path)).toEqual({away:true,delayMs:1200}); } finally { await rm(dir,{recursive:true,force:true}); }
});

test("verified acoustic affirmative is provisional until the same phone confirms physical playout",async()=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); const r=readback(await speak(c,proposal));
	expect(c.provisionalConfirmation(r.mark,"u-proof",r.phrase)).toBe(true);
	await c.played("wrong"); expect(f.writes).toEqual([]); const done=c.played(r.mark);
	expect((await c.played(r.mark)).kind).not.toBe("accepted"); expect((await done).kind).toBe("accepted");
	expect(f.writes).toHaveLength(1); f.core.close();
});
test("barge-in or a new speech start between provisional assent and played revokes it",async()=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); const r=readback(await speak(c,proposal));
	expect(c.provisionalConfirmation(r.mark,"u-proof",r.phrase)).toBe(true); c.speechStarted("wait");
	await c.played(r.mark); await c.speechFinished("wait","Wait, no."); expect(f.writes).toEqual([]); f.core.close();
});

test("ending a native Ask before escalation or before offer cannot produce an invitation",()=>{
	const f=fixture(); f.core.configure({away:false,delayMs:500}); f.offer("A"); f.core.end("A");
	f.core.end("B"); expect(f.offer("B")).toBe(false); f.advance(1000);
	expect(f.invites).toEqual([]); expect(f.core.list()).toEqual([]); f.core.close();
});
test("an outstanding clarification is aborted on hangup, including a provider that ignores its signal", async()=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief();
	const started=Promise.withResolvers<AbortSignal>(), slow=Promise.withResolvers<string>();
	f.setReply((_,signal)=>{started.resolve(signal); return slow.promise;});
	const outcome=c.consult("Why is Production recommended?").then(()=> "unexpected answer", (e:Error)=>e.message);
	const providerSignal=await started.promise;
	try {
		c.close();
		expect(providerSignal.aborted).toBe(true);
		// No provider resolution, no deadline. Hangup must settle before the next event-loop turn.
		expect(await Promise.race([outcome,nextTurn("still waiting")])).toBe("consult-unavailable");
		expect(f.core.list()).toHaveLength(1); expect(f.core.join("A")).toBeDefined();
	} finally { slow.resolve("Late answer"); f.core.close(); }
});
test("clarifications share only bounded history from the same pending request",async()=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); f.setReply(()=>"Keep the canary.");
	await c.consult("Unique question A"); await c.consult("What is the risk?"); expect(f.prompts.at(-1)).toContain("Unique question A");
	c.close(); f.core.end("A"); f.offer("B"); const b=f.core.join("B")!; await b.brief(); await b.consult("What is the risk?");
	expect(f.prompts.at(-1)).not.toContain("Unique question A"); f.core.close();
});
test("plain discussion and requests to perform work cannot create a draft, even with valid model output",async()=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief();
	for(const text of ["I think Production might work","Would you choose Production?","Run the deployment","Yes","Repeat the readback"]) {
		expect((await speak(c,text)).kind).toBe("ignored");
	}
	expect(f.writes).toEqual([]); f.core.close();
});
test("unsupported provider, excessive reply, or altered actual native result is not success",async()=>{
	const f=fixture(); f.core.offer(f.ask("no-model"),{},"project"); const bad=f.core.join("no-model")!;
	await expect(bad.brief()).rejects.toThrow("brief-unavailable"); bad.close(); f.setReply(()=>"x".repeat(9000));
	f.offer("overflow"); const overflow=f.core.join("overflow")!; await expect(overflow.brief()).rejects.toThrow("brief-unavailable"); overflow.close();
	f.setReply(p=>p.includes('"utterance"')?extraction():"Release lane is pending.");
	let attempts=0; f.core.offer({...f.ask("B"),async submitConfirmed(){attempts++; return "stale";}},f.ctx,"project");
	const c=f.core.join("B")!; await c.brief(); const r=readback(await speak(c,proposal));
	expect(c.provisionalConfirmation(r.mark,"receipt",r.phrase)).toBe(true); expect((await c.played(r.mark)).kind).toBe("stale");
	expect(f.core.join("B")).toBeUndefined(); expect(attempts).toBe(1); f.core.close();
});

test("preserves multi-option ordering and explicit empty checkbox without copying checked defaults",async()=>{
	const f=fixture(), form=`<form><p>Review teams?</p><label><input type="checkbox" name="team" value="qa" checked>Quality</label><label><input type="checkbox" name="team" value="ops">Operations</label><p>Announce?</p><label><input type="checkbox" name="notify" value="on" checked>Announce</label></form>`;
	f.core.offer({...f.ask("X"),html:form},f.ctx,"project"); const c=f.core.join("X")!; await c.brief();
	const text="My answer is Operations and Quality; do not announce.";
	const select=(team:string[])=>JSON.stringify({fields:[{name:"team",value:team,evidence:"Operations and Quality"},{name:"notify",value:null,evidence:"do not announce"}]});
	f.setReply(()=>select(["ops","qa"])); const invalid=await speak(c,text); expect(invalid.kind==="say" && !!invalid.mark).toBe(false);
	f.setReply(()=>select(["qa","ops"])); const r=readback(await speak(c,text)); expect(r.text).toContain("none selected"); c.played(r.mark); await speak(c,r.phrase);
	expect(f.writes).toEqual([["X",{team:["qa","ops"]}]]); f.core.close();
});
test("speaking an old affirmative after a fully played correction cannot confirm the new values",async()=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief(); const a=readback(await speak(c,proposal));
	f.setReply(()=>extraction("p",2).replace('"three"','"two"')); const b=readback(await speak(c,"I choose Production with two replicas.")); c.played(b.mark);
	expect((await speak(c,a.phrase)).kind).not.toBe("accepted"); expect(f.writes).toEqual([]); f.core.close();
});

test("synchronous native end during provider startup rejects without awaiting the provider",async()=>{
	const f=fixture(); f.offer("A"); const c=f.core.join("A")!; await c.brief();
	const slow=Promise.withResolvers<string>();
	f.setReply(()=>{ f.core.end("A"); return slow.promise; });
	try {
		const outcome=c.consult("Why this lane?").then(()=> "unexpected answer", (e:Error)=>e.message);
		expect(await Promise.race([outcome,nextTurn("still waiting")])).toBe("consult-unavailable");
		expect(c.signal.aborted).toBe(true); expect(f.core.list()).toEqual([]);
	} finally { slow.resolve("Late answer"); f.core.close(); }
});
