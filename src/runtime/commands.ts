const action = (value:string, description:string) => ({value,label:value,description});
const actions = [
	action("pair", "Pair a phone with this desktop"),
	action("status", "Show shared immediate and fallback settings"),
	action("on", "Enable immediate ringing for all connected sessions"),
	action("off", "Stop immediate ringing in all sessions; keep fallback"),
	action("fallback off", "Disable delayed ringing in all sessions"),
	action("fallback 90", "Set the shared delay to 90 seconds (or enter your own delay)"),
	action("help", "List Away commands"),
];

export function awaySuggestions(prefix:string, comparisonCode?:string) {
	const query=prefix.trimStart().toLowerCase().replace(/\s+/g," ");
	const candidates=comparisonCode ? [
		...actions,
		action(`deny ${comparisonCode}`, "Reject this pairing comparison"),
		action(`approve ${comparisonCode}`, "Approve only if all 12 emojis match"),
	] : actions;
	const matches=candidates.filter(item=>item.value.startsWith(query));
	return matches.length ? matches : null;
}

export const awayHelp=actions.filter(item=>item.value!=="help").map(item=>`/away ${item.label} — ${item.description}`).join("\n");
