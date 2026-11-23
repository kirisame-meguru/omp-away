import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-natives/clipboard";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Preferences } from "../decisions";
import { Enrollment } from "./enrollment";
import { connectRuntime, type MobileRuntime } from "./routing";

const runtimeWarnings: Readonly<Record<string,string>> = {
	phone_disconnected: "Phone connection was interrupted",
	relay_disconnected: "Relay disconnected; reconnecting",
	"phone-control-unavailable": "Could not update the phone",
	"unsupported-form": "This form is not supported by Away voice",
	"invite-unavailable": "Could not send the phone invitation",
};

export interface Admin extends Pick<MobileRuntime,"offer"|"end"|"close"> {
	readonly comparisonCode?: string;
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
	const token=await tokenFromFile(tokenFile);
	if (!isCurrent()) return;
	let live=true, commands=Promise.resolve(), nextPair=0, expires=0, pairing=false, routingReady=false;
	const current=()=>live && isCurrent();
	const notify=(text:string,type:"info"|"warning"|"error"="info")=>{if (current()) ctx.ui.notify(text,type)};
	const status=(prefs:Preferences)=>`Away (all sessions) immediate: ${prefs.away?"on":"off"}; fallback: ${prefs.delayMs===null?"off":`${prefs.delayMs/1000}s`}.`;
	const enrollment=new Enrollment(text=>ctx.ui.setWidget("omp-away-pairing",text?.split("\n")));
	function cancelEnrollment() {++nextPair; expires=0; enrollment.cancel()}
	const runtime=await resources.connect({url,stateDir,python,desktopToken:token,
		onRouting(next) {
			if (!current()) return;
			if (routingReady) notify(status(next));
			routingReady=true;
		},
		confirmPair:async (_device,emoji)=>{
			if (!current() || !idle() || Date.now()>=expires) return false;
			expires=0;
			const accepted=await enrollment.compare(emoji);
			return accepted && current() && idle();
		},
	},code=>{
		const warning=Object.hasOwn(runtimeWarnings,code) ? runtimeWarnings[code] : undefined;
		notify(`Away: ${warning ?? code}. The desktop form stays available.`,warning===undefined?"error":"warning");
	});
	if (!current()) {await runtime.close();return}
	notify("Away: secure mobile gateway ready");
	return {
		get comparisonCode() { return enrollment.comparisonCode },
		offer:runtime.offer,end:runtime.end,cancelEnrollment,
		async command(raw) {
			if (!current()) return;
			const args=raw.trim(), decision=/^(approve|deny) ([a-f0-9]{12})$/.exec(args);
			if (decision) {
				if (!idle() || !enrollment.decide(decision[1]==="approve",decision[2])) notify("No matching idle local comparison.","warning");
				return;
			}
			if (args==="pair") {
				if (!idle() || pairing) {notify("Pair only from the idle desktop composer.","warning");return}
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
			const fallback=/^fallback (off|[1-9]\d{0,6})$/.exec(args);
			if (args!=="" && args!=="on" && args!=="off" && args!=="status" && (!fallback || (fallback[1]!=="off" && Number(fallback[1])>2_147_483))) {
				notify("Usage: /away [on|off|status|fallback off|fallback SECONDS|pair]", "warning");return;
			}
			// Preserve this session's command order; the broker serializes patches
			// across all sessions and broadcasts the committed state back to us.
			commands=commands.then(async()=>{
				if (!current()) return;
				const patch:Partial<Preferences>=args==="status" ? {} : fallback ? {delayMs:fallback[1]==="off"?null:Number(fallback[1])*1000} : {away:args!=="off"};
				await runtime.configure(patch);
			}).catch(()=>notify("Away shared routing could not be updated; no local-only change was applied.","error"));
			await commands;
		},
		async close() {live=false;cancelEnrollment();await Promise.all([runtime.close(),commands])},
	};
}
