import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-natives/clipboard";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Preferences } from "../decisions";
import { Enrollment } from "./enrollment";
import { connectRuntime, type MobileRuntime } from "./routing";
import { PairingQr } from "./pairing-qr";
import { clean, PairingComparison } from "../presentation";
import { AwayNotifications } from "./notifications";
import { message, routingStatus } from "../messages";

export interface Admin extends Pick<MobileRuntime,"offer"|"end"|"endCall"|"call"|"close"|"ringing"> {
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
}, notifications = new AwayNotifications((text,type)=>{if(isCurrent()) ctx.ui.notify(text,type)})):Promise<Admin|undefined> {
	const {OMP_AWAY_URL:url,OMP_AWAY_TOKEN_FILE:tokenFile,OMP_AWAY_STATE_DIR:stateDir,OMP_AWAY_TUNNEL_PYTHON:python}=resources.env;
	if (!url || !tokenFile || !isAbsolute(tokenFile) || !stateDir || !isAbsolute(stateDir) || (python!==undefined && !isAbsolute(python))) throw Error("incomplete-gateway-settings");
	const token=await tokenFromFile(tokenFile);
	if (!isCurrent()) return;
	let live=true, commands=Promise.resolve(), nextPair=0, expires=0, pairing=false;
	let preferences:Preferences={away:false,delayMs:null};
	const current=()=>live && isCurrent();
	const notify=(text:string,type:"info"|"warning"|"error"="info")=>{if (current()) ctx.ui.notify(clean(message(notifications.language,text)),type)};
	const status=(prefs:Preferences)=>`Away · ${routingStatus(notifications.language,prefs.away,prefs.delayMs)}`;
	const enrollment=new Enrollment((text,comparison)=>ctx.ui.setWidget("omp-away-pairing",comparison
		? ()=>new PairingComparison(comparison.emoji,comparison.code,(accept,code)=>{
			if (!current()) return;
			if (!idle() || !enrollment.decide(accept,code)) notify("No matching idle local comparison.","warning");
		},notifications.language).view
		: text?.split("\n")));
	let expiryTimer: NodeJS.Timeout | undefined;
	function clearQr() {
		clearTimeout(expiryTimer);
		expiryTimer=undefined;
		ctx.ui.setWidget("omp-away-pairing-qr",undefined);
	}
	function cancelEnrollment() {++nextPair; expires=0; clearQr(); enrollment.cancel()}
	function cancelPairing() {
		if (!current()) return;
		cancelEnrollment();
		notify("Away pairing cancelled; no new device approved.");
	}
	const runtime=await resources.connect({url,stateDir,python,desktopToken:token,notifications,
		onLanguage(language) { if (current()) notifications.setLanguage(language); },
		onRouting(next) {
			if (!current()) return;
			preferences=next;
			notifications.health("Routing",language=>routingStatus(language,next.away,next.delayMs));
		},
		confirmPair:async (_device,emoji)=>{
			if (!current() || !idle() || Date.now()>=expires) return false;
			expires=0;
			clearQr();
			const accepted=await enrollment.compare(emoji);
			return accepted && current() && idle();
		},
	},(code,requestId)=>{
		if(!current()) return;
		notifications.diagnostic(code);
		if(code==="invite-unavailable") {
			notifications.warn("invite","A phone invitation could not be sent. Open the phone inbox, or answer on the desktop. See /away status.");
			notifications.suppress("mobile-outage");
		}
		else if(code==="unsupported-form" && (preferences.away || preferences.delayMs!==null))
			notifications.warn(`form:${requestId}`,"This question cannot be forwarded by Away. Answer on the desktop or in /questions.");
		else if(code==="call-interrupted" || code==="voice-unavailable") {
			notifications.warn(`call:${requestId}`,code==="call-interrupted"
				? "The active phone call disconnected. Disconnection does not confirm an answer; continue on the desktop or reconnect from the phone."
				: "The phone call could not start or continue. Continue on the desktop or retry from the phone.");
		} else if(code==="answer-receipt-unavailable") {
			notifications.warn(`answer:${requestId}`,"The phone's answer receipt could not be delivered. Check the desktop or /questions before retrying; nothing was resent.");
		} else if(code==="answer-uncertain") {
			notifications.warn(`answer:${requestId}`,"Answer submission could not be confirmed. Check the desktop or /questions before retrying; nothing was resent.");
		} else if(code==="confirmation_failed") {
			cancelEnrollment();
			notifications.warn("pairing-failed","Pairing confirmation could not be completed. Check the phone and /away status before trying again.");
		} else if(code==="translation-unavailable") {
			notifications.warn(`translation:${requestId}`,"Translation unavailable. Showing the original question.");
		} else if(code==="language-preference-unavailable") {
			notifications.warn("language-preference","The language preference could not be saved. Check /away status before trying again.");
		}
	});
	if (!current()) {await runtime.close();return}
	return {
		get ringing() { return runtime.ringing },
		get comparisonCode() { return enrollment.comparisonCode },
		offer:runtime.offer,end:runtime.end,endCall:runtime.endCall,call:runtime.call,cancelEnrollment,
		async command(raw) {
			if (!current()) return;
			const args=raw.trim(), decision=/^(approve|deny) ([a-f0-9]{12})$/.exec(args);
			if (decision) {
				if (!idle() || !enrollment.decide(decision[1]==="approve",decision[2])) notify("No matching idle local comparison.","warning");
				return;
			}
			if (args==="pair cancel") {cancelPairing();return}
			if (args==="pair" || args==="pair clipboard") {
				if (!idle() || pairing) {notify("Pair only from the idle desktop composer.","warning");return}
				cancelEnrollment();const epoch=nextPair;pairing=true;
				notifications.recover("pairing-failed");
				try {
					const payload=await runtime.pair();
					if (!current() || !idle() || epoch!==nextPair) return;
					if (args==="pair clipboard") {
						await resources.copy(payload,python);
						if (!current() || !idle() || epoch!==nextPair) return;
					} else {
						let availableRows=()=>0;
						const qr=new PairingQr(payload,()=>availableRows(),()=>{
							if (epoch===nextPair) cancelPairing();
						},notifications.language);
						ctx.ui.setWidget("omp-away-pairing-qr",tui=>{
							availableRows=()=>tui.size().rows;
							return qr.view;
						});
					}
					expires=Date.now()+600_000;
					expiryTimer=setTimeout(()=>{
						if (epoch!==nextPair) return;
						cancelEnrollment();
						notify("Away pairing expired. Run /away pair for a new QR.","warning");
					},600_000);
					expiryTimer.unref();
					notify(args==="pair clipboard"
						? "Away enrollment copied. Paste only into your phone's pairing screen. Compare all 12 emojis here and on the phone."
						: "Scan the QR with Away on your phone, then compare all 12 emojis. Clipboard alternative: /away pair clipboard.");
				} catch {
					if (epoch===nextPair) cancelEnrollment();
					notify(args==="pair clipboard"
						? "Away enrollment or private clipboard unavailable; no device approved."
						: "Away QR unavailable. Retry /away pair or use /away pair clipboard; no device approved.","error");
				}
				finally {pairing=false}
				return;
			}
			const fallback=/^fallback (off|[1-9]\d{0,6})$/.exec(args);
			if(args==="status") {await commands;if(current()) notify(`${message(notifications.language,"Away status")}\n${notifications.status()}`);return}
			if (args!=="" && args!=="on" && args!=="off" && (!fallback || (fallback[1]!=="off" && Number(fallback[1])>2_147_483))) {
				notify("Usage: /away [on|off|status|fallback off|fallback SECONDS|pair [clipboard|cancel]]", "warning");return;
			}
			// Preserve this session's command order; the broker serializes patches
			// across all sessions and broadcasts the committed state back to us.
			commands=commands.then(async()=>{
				if (!current()) return;
				const patch:Partial<Preferences>=fallback ? {delayMs:fallback[1]==="off"?null:Number(fallback[1])*1000} : {away:args!=="off"};
				await runtime.configure(patch);
				notify(status(preferences));
			}).catch(()=>notify("Away shared routing could not be updated; no local-only change was applied.","error"));
			await commands;
		},
		async close() {live=false;notifications.close();cancelEnrollment();await Promise.all([runtime.close(),commands])},
	};
}
