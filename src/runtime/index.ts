import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-natives/clipboard";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreferences, savePreferences, type Preferences } from "../decisions";
import { Enrollment } from "./enrollment";
import { connectRuntime, type MobileRuntime } from "./routing";

export interface Admin extends Pick<MobileRuntime,"offer"|"end"|"close"> {
	command(args:string):Promise<void>;
	cancelEnrollment():void;
}

export function gatewayConfigured(env=process.env):boolean {
	return [env.OMP_AWAY_URL,env.OMP_AWAY_TOKEN_FILE,env.OMP_AWAY_STATE_DIR,env.OMP_AWAY_TUNNEL_PYTHON].some(value=>value!==undefined);
}

async function tokenFromFile(path:string) {
	const file=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const st=await file.stat();
		if (!st.isFile() || st.nlink!==1 || st.size>128 || (process.platform!=="win32" && ((st.mode & 0o077)!==0 || st.uid!==process.getuid!()))) throw Error("unsafe-token-file");
		const text=(await file.readFile("utf8")).trim();
		if (!/^[A-Za-z0-9_-]{43}$/.test(text) || Buffer.from(text,"base64url").toString("base64url")!==text) throw Error("invalid-token-file");
		return text;
	} finally {await file.close()}
}

/** Use the OS clipboard, never the host's OSC 52, composer, event bus or transcript. */
async function copyEnrollment(json:string,python:string|undefined) {
	if (process.platform!=="win32") {copyToClipboard(json);return}
	const child=Bun.spawn([python ?? "python","-I",fileURLToPath(new URL("./private_clipboard.py",import.meta.url))],{
		stdin:new Blob([json]),stdout:"ignore",stderr:"ignore",windowsHide:true,
		env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH},
	});
	if (await child.exited!==0) throw Error("clipboard-unavailable");
}

interface AdminResources { env:NodeJS.ProcessEnv; copy:typeof copyEnrollment; connect:typeof connectRuntime }
export async function openAdmin(ctx:ExtensionContext, isCurrent:()=>boolean, idle:()=>boolean, resources:AdminResources={
	env:process.env,copy:copyEnrollment,connect:connectRuntime,
}):Promise<Admin|undefined> {
	const {OMP_AWAY_URL:url,OMP_AWAY_TOKEN_FILE:tokenFile,OMP_AWAY_STATE_DIR:stateDir,OMP_AWAY_TUNNEL_PYTHON:python}=resources.env;
	if (!url || !tokenFile || !isAbsolute(tokenFile) || !stateDir || !isAbsolute(stateDir) || (python!==undefined && !isAbsolute(python))) throw Error("incomplete-gateway-settings");
	const path=join(stateDir,"routing.json");
	const [token,initial]=await Promise.all([tokenFromFile(tokenFile),loadPreferences(path)]);
	if (!isCurrent()) return;
	let live=true, prefs=initial, writes=Promise.resolve(), nextPair=0, expires=0, pairing=false;
	const current=()=>live && isCurrent();
	const notify=(text:string,type:"info"|"error"="info")=>{if (current()) ctx.ui.notify(text,type)};
	const enrollment=new Enrollment(text=>ctx.ui.setWidget("omp-away-pairing",text?.split("\n")));
	function cancelEnrollment() {++nextPair; expires=0; enrollment.cancel()}
	const runtime=await resources.connect({url,stateDir,python,desktopToken:token,
		confirmPair:async (_device,emoji)=>{
			if (!current() || !idle() || Date.now()>=expires) return false;
			expires=0;
			const accepted=await enrollment.compare(emoji);
			return accepted && current() && idle();
		},
	},prefs,code=>notify(`Away: ${code}. The desktop form stays available.`,"error"));
	if (!current()) {await runtime.close();return}
	notify("Away: secure mobile gateway ready");
	return {
		offer:runtime.offer,end:runtime.end,cancelEnrollment,
		async command(raw) {
			if (!current()) return;
			const args=raw.trim(), decision=/^(approve|deny) ([a-f0-9]{12})$/.exec(args);
			if (decision) {
				if (!idle() || !enrollment.decide(decision[1]==="approve",decision[2])) notify("No matching idle local comparison.","error");
				return;
			}
			if (args==="pair") {
				if (!idle() || pairing) {notify("Pair only from the idle desktop composer.","error");return}
				cancelEnrollment();const epoch=nextPair;pairing=true;
				try {
					const payload=await runtime.pair();
					if (!current() || !idle() || epoch!==nextPair) return;
					await resources.copy(payload,python);
					if (!current() || !idle() || epoch!==nextPair) return;
					expires=Date.now()+600_000;
					notify("Away enrollment copied. Paste only into your phone's pairing screen or a trusted offline QR renderer. Compare all 12 emojis here and on the phone.");
				} catch {notify("Away enrollment or private clipboard unavailable; no device approved.","error")}
				finally {pairing=false}
				return;
			}
			if (args==="status") {notify(`Away immediate: ${prefs.away?"on":"off"}; fallback: ${prefs.delayMs===null?"off":`${prefs.delayMs/1000}s`}.`);return}
			const fallback=/^fallback (off|[1-9]\d{0,6})$/.exec(args);
			if (args!=="" && args!=="on" && args!=="off" && (!fallback || (fallback[1]!=="off" && Number(fallback[1])>2_147_483))) {
				notify("Usage: /away [on|off|status|fallback off|fallback SECONDS|pair]", "error");return;
			}
			// Serialize read-modify-write, including concurrent toggles and session shutdown.
			writes=writes.then(async()=>{
				if (!current()) return;
				const next:Preferences=fallback ? {...prefs,delayMs:fallback[1]==="off"?null:Number(fallback[1])*1000} : {...prefs,away:args===""?!prefs.away:args==="on"};
				await savePreferences(path,next); if (!current()) return;
				runtime.configure(next);prefs=next;
				notify(`Away immediate: ${prefs.away?"on":"off"}; fallback: ${prefs.delayMs===null?"off":`${prefs.delayMs/1000}s`}.`);
			}).catch(()=>notify("Away routing preferences could not be saved.","error"));
			await writes;
		},
		async close() {live=false;cancelEnrollment();await Promise.all([runtime.close(),writes])},
	};
}
