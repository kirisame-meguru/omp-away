export interface Preferences { away: boolean; delayMs: number | null }
export function preferencePatch(data: unknown): Partial<Preferences> {
	if (!data || typeof data!=="object" || Array.isArray(data) ||
		Object.keys(data).some(key=>key!=="away" && key!=="delayMs")) throw Error("invalid-routing-preferences");
	const patch:Partial<Preferences>={};
	if ("away" in data) {
		if (typeof data.away!=="boolean") throw Error("invalid-routing-preferences");
		patch.away=data.away;
	}
	if ("delayMs" in data) {
		const delay=data.delayMs;
		if (delay!==null && (typeof delay!=="number" || !Number.isSafeInteger(delay) || delay<0 || delay>2_147_483_647)) throw Error("invalid-routing-preferences");
		patch.delayMs=delay;
	}
	return patch;
}
export function preferences(data: unknown): Preferences {
	const patch=preferencePatch(data);
	if (patch.away===undefined || patch.delayMs===undefined) throw Error("invalid-routing-preferences");
	return {away:patch.away,delayMs:patch.delayMs};
}
