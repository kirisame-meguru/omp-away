import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Preferences { away: boolean; delayMs: number | null }
export function preferences(data: unknown): Preferences {
	if (!data || typeof data !== "object" || !("away" in data) || typeof data.away !== "boolean" || !("delayMs" in data)) throw Error("invalid-routing-preferences");
	const delayMs = data.delayMs;
	if (delayMs !== null && (typeof delayMs !== "number" || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647)) throw Error("invalid-routing-preferences");
	return { away: data.away, delayMs };
}
export async function loadPreferences(path: string): Promise<Preferences> {
	try { return preferences(JSON.parse(await readFile(path,"utf8"))); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {away:false,delayMs:null};
		throw Error("routing-preferences-unavailable");
	}
}
/** Replace atomically; callers serialize concurrent preference changes per profile. */
export async function savePreferences(path: string, data: Preferences): Promise<void> {
	const json = JSON.stringify(preferences(data));
	const temp = `${path}.${randomUUID()}.tmp`;
	await mkdir(dirname(path), {recursive:true,mode:0o700});
	try { await writeFile(temp, json, {flag:"wx",mode:0o600}); await rename(temp,path); }
	finally { await rm(temp, {force:true}); }
}
