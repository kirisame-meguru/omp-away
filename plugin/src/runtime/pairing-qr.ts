import type { Component } from "@oh-my-pi/pi-tui";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { QrCode, renderQrHalfBlocks } from "@oh-my-pi/pi-tui/chrome/qrcode";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { col, node, text } from "@oh-my-pi/pi-tui/native/describe";
import { nativeImageNode } from "@oh-my-pi/pi-tui/native/blobs";

const heading = "Scan with Away on your phone. Expires in 10 minutes.";
const fallback = "QR cannot fit. Enlarge the terminal or use /away pair clipboard.";
const cancelHint = "Cancel: /away pair cancel";

/** Ephemeral UI only: never render the enrollment payload as text or a link. */
export class PairingQr implements Component {
	private readonly qr: QrCode;
	private readonly lines: string[];
	private readonly minWidth: number;
	private native?: NativeNode;

	constructor(payload: string, private readonly rows: () => number, private readonly cancel: () => void) {
		this.qr = QrCode.encodeText(payload, "M");
		this.lines = renderQrHalfBlocks(this.qr);
		this.minWidth = this.lines.reduce((width, line) => Math.max(width, visibleWidth(line)), 0);
	}

	render(width: number): string[] {
		// Leave room for the status bar and composer instead of filling the dock.
		const content = width < this.minWidth || this.rows() < this.lines.length + 10
			? [fallback, cancelHint]
			: [heading, ...this.lines, cancelHint];
		return [...content.map(line => {
			const clipped = truncateToWidth(line, width);
			return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))) + clipped;
		}), ""];
	}

	describe(cx: DescribeContext): NativeNode {
		if (!cx.supports("image")) {
			return col([text(fallback), text(cancelHint)], { align: "center", gap: "sm" });
		}
		if (this.native) return this.native;
		// A bounded image, not a font-sized code block: preserve square modules
		// and the four-module quiet zone independently of text size/theme.
		const size = this.qr.size + 8;
		let path = "";
		for (let y = 0; y < this.qr.size; y++) {
			for (let x = 0; x < this.qr.size; x++) {
				if (this.qr.module(x, y)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
			}
		}
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size}v${size}H0z"/><path fill="black" d="${path}"/></svg>`;
		this.native = col([
			text(heading),
			nativeImageNode(new TextEncoder().encode(svg), "image/svg+xml", {
				alt: "Away pairing QR",
				w: 360, h: 360, max: { w: 360, h: "14lines" },
			}),
			node("button", { text: "Cancel pairing", actions: { click: "cancel-pair" } }),
			text(cancelHint),
			node("spacer", { size: "md" }),
		], { role: "omp.away.pairing.qrcode", align: "center", gap: "sm" });
		return this.native;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "cancel-pair") this.cancel();
	}
}
