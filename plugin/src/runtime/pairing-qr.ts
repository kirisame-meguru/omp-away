import type { Component } from "@oh-my-pi/pi-tui";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { QrCode, renderQrHalfBlocks } from "@oh-my-pi/pi-tui/chrome/qrcode";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { col, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { nativeImageNode } from "@oh-my-pi/pi-tui/native/blobs";
import { applyAwayStyles, awayBlock, awayStatus } from "../presentation";
import type { Language } from "../language";
import { message } from "../messages";

const heading = "Scan with Away on your phone. Expires in 10 minutes.";
const fallback = "QR cannot fit. Enlarge the terminal or use /away pair clipboard.";
const cancelHint = "Cancel: /away pair cancel";

/** Ephemeral UI only: never render the enrollment payload as text or a link. */
export class PairingQr implements Component {
	private readonly qr: QrCode;
	private readonly lines: string[];
	private readonly minWidth: number;
	private native?: NativeNode;
	private styled = false;

	constructor(payload: string, private readonly rows: () => number, private readonly cancel: () => void, readonly language: Language = "en") {
		this.qr = QrCode.encodeText(payload, "M");
		this.lines = renderQrHalfBlocks(this.qr);
		this.minWidth = this.lines.reduce((width, line) => Math.max(width, visibleWidth(line)), 0);
	}

	render(width: number): string[] {
		// Leave room for the status bar and composer instead of filling the dock.
		const content = width < this.minWidth || this.rows() < this.lines.length + 10
			? [message(this.language,fallback), message(this.language,cancelHint)]
			: [message(this.language,heading), ...this.lines, message(this.language,cancelHint)];
		return [...content.map(line => {
			const clipped = truncateToWidth(line, width);
			return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))) + clipped;
		}), ""];
	}

	describe(cx: DescribeContext): NativeNode {
		if (!this.styled) this.styled = applyAwayStyles(cx);
		if (cx.supports("image") && !this.native) {
			// Square modules and the quiet zone must stay high contrast in either theme.
			const size = this.qr.size + 8;
			let path = "";
			for (let y = 0; y < this.qr.size; y++) {
				for (let x = 0; x < this.qr.size; x++) {
					if (this.qr.module(x, y)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
				}
			}
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size}v${size}H0z"/><path fill="black" d="${path}"/></svg>`;
			this.native = nativeImageNode(new TextEncoder().encode(svg), "image/svg+xml", {
				alt: message(this.language,"Away pairing QR"), w: 220, h: 220, max: { w: 220, h: "12lines" },
			});
		}
		return awayBlock(cx, { role: "away.pairing.qrcode", title: message(this.language,"Pair phone"), target: "Away", status: "pending" }, [
			col([
				text(message(this.language,cx.supports("image") ? "Scan with Away on your phone, then compare all 12 emojis." : "QR images are unavailable in this terminal."), { wrap: "word" }),
				...(cx.supports("image") && this.native ? [this.native] : []),
				text([span(message(this.language,"Clipboard alternative: /away pair clipboard"), "muted")], { wrap: "word" }),
				row([
					awayStatus(message(this.language,"Expires in 10 minutes")),
					node("button", { role: "omp.btn", text: message(this.language,"Cancel pairing"), variant: "quiet", size: "sm", actions: { click: "cancel-pair" } }),
				], { role: "away.footer", wrap: true, gap: "sm", justify: "between", align: "center" }),
			], { gap: "sm" }),
		]);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "cancel-pair") this.cancel();
	}
}
