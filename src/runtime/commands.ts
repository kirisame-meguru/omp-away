const action = (value:string, description:string) => ({value,label:value,description});
const actions = [
	action("pair", "Pair a phone with this desktop"),
	action("status", "Show immediate and fallback settings"),
	action("on", "Ring the phone immediately for new Asks"),
	action("off", "Stop immediate ringing; keep the fallback setting"),
	action("fallback off", "Disable delayed ringing"),
	action("fallback 90", "Ring after 90 seconds (or enter your own delay)"),
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
