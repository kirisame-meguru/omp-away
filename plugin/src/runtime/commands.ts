const action = (value:string, description:string) => ({value,label:value,description});
const actions = [
	action("pair", "Show a QR to pair a phone with this desktop"),
	action("pair clipboard", "Copy pairing data instead of displaying a QR"),
	action("pair cancel", "Cancel pending pairing and hide the QR"),
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
