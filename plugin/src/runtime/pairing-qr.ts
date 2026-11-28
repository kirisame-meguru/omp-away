import { UiNode, nativeSupports } from "@oh-my-pi/pi-tui";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { encodeQr, qrHalfBlocks } from "@oh-my-pi/pi-coding-agent/ui/transcript/figures/qr";
import { awayBlock, pairingExpiry } from "../presentation";
import type { Language } from "../language";
import { message } from "../messages";

const heading = "Scan with Away on your phone. Expires in 10 minutes.";
const fallback = "QR cannot fit. Enlarge the terminal or use /away pair clipboard.";
const cancelHint = "Cancel: /away pair cancel";

/** Ephemeral UI only: never render the enrollment payload as text or a link. */
export class PairingQr {
	readonly view: UiNode;
	private readonly lines: string[];
	private readonly minWidth: number;

	constructor(payload: string, private readonly rows: () => number, cancel: () => void, readonly language: Language = "en", expiresAt = Date.now() + 600_000) {
		const qr = encodeQr(payload, "M");
		this.lines = qrHalfBlocks(qr, "dark").map(line => `\x1b[47m\x1b[30m${line}\x1b[0m`);
		this.minWidth = this.lines.reduce((width, line) => Math.max(width, visibleWidth(line)), 0);
		const size = qr.size + 8;
		let path = "";
		for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
			if (qr.modules[y]![x]) path += `M${x + 4} ${y + 4}h1v1h-1z`;
		}
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size}v${size}H0z"/><path fill="black" d="${path}"/></svg>`;
		const image = new UiNode("image", {
			blob: registerBlob(new TextEncoder().encode(svg), "image/svg+xml"),
			alt: message(language, "Away pairing QR"), role: "away.pairing.image", w: 220, h: 220,
		});
		const terminal = new UiNode("canvas", { paint: (width: number) => this.render(width) });
		const native = awayBlock({ role: "away.pairing.qrcode", title: message(language, "Pair phone"), status: "pending" }, [
			new UiNode("text", { text: message(language, "Scan with Away on your phone"), wrap: "word" }),
			image,
			new UiNode("text", { spans: [{ t: language === "ru" ? "или · " : "or · ", s: "muted" }, { t: "/away pair clipboard", s: "mono muted" }], wrap: "word" }),
			new UiNode("row", { role: "away.footer", wrap: true, gap: "sm", justify: "center", align: "center", children: [
				pairingExpiry(expiresAt, language),
				new UiNode("button", { role: "omp.btn", text: message(language, "Cancel pairing"), variant: "quiet", size: "sm", actions: { click: "cancel-pair" }, onAction: (act: string) => { if (act === "cancel-pair") cancel(); } }),
			] }),
		]);
		this.view = new UiNode("col", { role: "away.pairing.widget", children: () => nativeSupports("image") ? native : terminal });
	}

	render(width: number): string[] {
		// Never clip a QR symbol: the entire quiet zone must fit.
		const content = width < this.minWidth || this.rows() < this.lines.length + 10
			? [message(this.language, fallback), message(this.language, cancelHint)]
			: [message(this.language, heading), ...this.lines, message(this.language, cancelHint)];
		return [...content.map(line => {
			const clipped = truncate(line, width);
			return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))) + clipped;
		}), ""];
	}
}
