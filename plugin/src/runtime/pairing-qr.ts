import type { Component } from "@oh-my-pi/pi-tui";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { QrCode, renderQrHalfBlocks, renderQrText } from "@oh-my-pi/pi-tui/chrome/qrcode";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { code, col, text } from "@oh-my-pi/pi-tui/native/describe";

const heading = "Scan with Away on your phone. Expires in 10 minutes.";
const fallback = "QR cannot fit. Enlarge the terminal or use /away pair clipboard.";

/** Ephemeral UI only: never render the enrollment payload as text or a link. */
export class PairingQr implements Component {
	private readonly qr: QrCode;
	private readonly lines: string[];
	private readonly minWidth: number;
	private native?: { dark: boolean; node: NativeNode };

	constructor(payload: string, private readonly rows: () => number) {
		this.qr = QrCode.encodeText(payload, "M");
		this.lines = renderQrHalfBlocks(this.qr);
		this.minWidth = this.lines.reduce((width, line) => Math.max(width, visibleWidth(line)), 0);
	}

	render(width: number): string[] {
		if (width < this.minWidth || this.rows() < this.lines.length + 4) {
			return [truncateToWidth(fallback, width)];
		}
		return [truncateToWidth(heading, width), ...this.lines];
	}

	describe(cx: DescribeContext): NativeNode {
		if (this.native?.dark === cx.dark) return this.native.node;
		const node = col([
			text(heading),
			code(renderQrText(this.qr, cx.dark).join("\n"), { lang: "text", wrap: false }),
		], { role: "omp.away.pairing.qrcode" });
		this.native = { dark: cx.dark, node };
		return node;
	}
}
