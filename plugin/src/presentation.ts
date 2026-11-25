import { Text, replaceTabs, writeTerminalSequence, type Component } from "@oh-my-pi/pi-tui";
import { col, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type {
  DescribeContext,
  NativeChild,
  NativeNode,
  NativeUiEvent,
} from "@oh-my-pi/pi-tui/native/node";
import type {
  NativeToolView,
  RenderResultOptions,
  ToolRenderResult,
} from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";

export const clean = (value: string): string => replaceTabs(sanitizeText(value));
type Tone = "muted" | "success" | "warning" | "error";

// Text-only output needs the same well as OMP's code output, not another card.
const styles =
  "\x1b_tsp;s;" +
  JSON.stringify({
    name: "omp-away",
    css: `
[data-role^='away.'], [data-role^='away.'] .sf-text,
[data-role^='away.'] .sf-tool-target.text { font-family: var(--sans); }
.sf-tool[data-role='omp.tool.away_end_call'] > .sf-tool-body,
.sf-tool[data-role^='away.'] > .sf-tool-body {
 border: 1px solid var(--l2); border-radius: var(--r-card);
 background: var(--code-bg); padding: 12px 14px; margin-top: 8px;
}
[data-role='away.footer'] { border-top: 1px solid var(--l2); padding-top: 8px; }
[data-role='away.comparison'] { font-size: 22px; line-height: 1.6; }
`,
  }) +
  "\x1b\\";

export function applyAwayStyles(cx: DescribeContext): boolean {
  if (!cx.feature("styles")) return false;
  writeTerminalSequence(styles);
  return true;
}

export function awayStatus(label: string, tone: Tone = "muted", icon?: string): NativeNode {
  return row(
    [
      node("icon", {
        name:
          icon ??
          (tone === "success"
            ? "check"
            : tone === "error"
              ? "x"
              : tone === "warning"
                ? "warn"
                : "clock"),
        tone,
      }),
      text([span(clean(label), tone)], { wrap: "word" }),
    ],
    { gap: "sm", align: "baseline", role: "away.status" },
  );
}

export function awayBlock(
  cx: DescribeContext,
  props: {
    role: string;
    title: string;
    target?: string;
    status: "pending" | "done" | "error" | "cancelled";
    collapsed?: boolean;
    note?: string;
  },
  children: readonly NativeChild[],
): NativeNode {
  const collapsible = props.collapsed !== undefined;
  return cx.supports("tool")
    ? node(
        "tool",
        {
          ...props,
          name: "away",
          targetKind: "text",
          frame: "card",
          collapsible,
          preview: "children",
        },
        children,
      )
    : node(
        "card",
        {
          role: props.role,
          head: [
            span(props.title, "strong"),
            ...(props.target ? [span(` · ${props.target}`)] : []),
          ],
          status: props.status,
          collapsible,
          collapsed: props.collapsed,
          preview: { lines: 6 },
        },
        children,
      );
}

/** A component boundary gives styling a capability-aware context without a nested frame. */
class EndCallBody implements Component {
  #styled = false;
  constructor(
    readonly label: string,
    readonly tone: Tone,
    readonly detail: string,
    readonly icon?: string,
  ) {}
  render(width: number): readonly string[] {
    return new Text(`${this.label}\n${this.detail}`, 0, 0).render(width);
  }
  describe(cx: DescribeContext): NativeNode {
    if (!this.#styled) this.#styled = applyAwayStyles(cx);
    return col(
      [awayStatus(this.label, this.tone, this.icon), text(this.detail, { wrap: "word" })],
      { gap: "sm", role: "away.end-call" },
    );
  }
}

function endCallBody(result: ToolRenderResult, options: RenderResultOptions): EndCallBody {
  if (options.isPartial)
    return new EndCallBody("Ending call", "muted", "Stopping handset audio and live mode…");
  if (result.isError)
    return new EndCallBody(
      "Could not end call",
      "error",
      "The call may still be active. Check live mode before retrying.",
    );
  const ended = isRecord(result.details) && result.details.ended === true;
  return ended
    ? new EndCallBody(
        "Call ended",
        "success",
        "Audio stopped. This does not submit an answer or resolve a pending form.",
      )
    : new EndCallBody(
        "No matching active call",
        "muted",
        "Nothing was ended in this session. Pending questions are unchanged.",
        "info",
      );
}

export const endCallRenderers = {
  mergeCallAndResult: true,
  renderCall() {
    return new Text("End call · Away", 0, 0);
  },
  renderResult(result: ToolRenderResult, options: RenderResultOptions) {
    return endCallBody(result, options);
  },
  describeCall(_args: unknown, options: RenderResultOptions): NativeToolView {
    const waiting = options.executionStarted === false;
    return {
      tool: { title: "End call", target: "Away", targetKind: "text" },
      inline: false,
      body: [
        new EndCallBody(
          options.cancelled ? "Cancelled" : waiting ? "Waiting to end call" : "Ending call",
          "muted",
          options.cancelled
            ? "Call termination was not confirmed."
            : waiting
              ? "Waiting for execution. Audio has not been stopped."
              : "Stopping handset audio and live mode…",
          options.cancelled ? "x" : undefined,
        ),
      ],
      preview: "children",
    };
  },
  describeResult(result: ToolRenderResult, options: RenderResultOptions): NativeToolView {
    return {
      tool: { title: "End call", target: "Away", targetKind: "text" },
      inline: false,
      body: [endCallBody(result, options)],
      preview: "children",
    };
  },
};

/** The context envelope is model input, not a transcript UI. Never display its instructions or HTML by default. */
export class CallMessage implements Component {
  #styled = false;
  readonly title: string;
  readonly target: string;
  readonly summary: string;
  readonly detail?: string;
  readonly requestId?: string;
  constructor(
    content: string,
    readonly result: boolean,
    private expanded: boolean,
  ) {
    let data: Record<string, unknown> = {};
    try {
      const source = result
        ? content
        : content
            .slice(content.lastIndexOf('\n{"requestId":') + 1)
            .replace(/\n<\/omp-away-plugin>\s*$/, "");
      const parsed: unknown = JSON.parse(source);
      if (isRecord(parsed)) data = parsed;
    } catch {
      /* Old or unknown messages get a safe summary, not a raw payload. */
    }
    this.title = result ? "Voice discussion" : "Continue by voice";
    this.target = typeof data.title === "string" ? clean(data.title) : "Away";
    this.summary = result
      ? "Discussion returned to the agent"
      : "Phone picked up · pickup is not an answer";
    const detail = result ? data.voiceDiscussion : data.blockedWork;
    if (typeof detail === "string") this.detail = clean(detail);
    const id = result ? data.question : data.requestId;
    if (typeof id === "string") this.requestId = clean(id);
  }
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }
  render(width: number): readonly string[] {
    return new Text(
      [
        `${this.title} · ${this.target}`,
        this.summary,
        ...(this.detail ? [this.shownDetail()] : []),
        ...(this.expanded && this.requestId ? [`Request: ${this.requestId}`] : []),
      ].join("\n"),
      0,
      0,
    ).render(width);
  }
  private shownDetail(): string {
    const detail = this.detail ?? "";
    return !this.expanded && detail.length > 280
      ? `${Array.from(detail).slice(0, 280).join("")}…`
      : detail;
  }
  describe(cx: DescribeContext): NativeNode {
    if (!this.#styled) this.#styled = applyAwayStyles(cx);
    return awayBlock(
      cx,
      {
        role: "away.call-message",
        title: this.title,
        target: this.target,
        status: "done",
        collapsed: !this.expanded,
      },
      [
        col(
          [
            ...(this.detail ? [text(this.shownDetail(), { wrap: "word" })] : []),
            awayStatus(this.summary, "muted", this.result ? "check" : "info"),
            ...(this.expanded && this.requestId
              ? [text([span(`Request: ${this.requestId}`, "muted")], { wrap: "word" })]
              : []),
          ],
          { role: "away.receipt", gap: "sm" },
        ),
      ],
    );
  }
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "toggle" && event.key === "") this.expanded = !event.collapsed;
  }
}

/** Confirmation remains ephemeral and bound to one comparison code, including after a stale click. */
export class PairingComparison implements Component {
  #styled = false;
  constructor(
    readonly emoji: string,
    readonly code: string,
    readonly decide: (accept: boolean, code: string) => void,
  ) {}
  render(width: number): readonly string[] {
    return new Text(
      `Pair phone · Away\nCompare all 12 emojis on your phone:\n${clean(this.emoji)}\nOnly approve if every emoji matches. Expires in 2 minutes.\nMatch: /away approve ${this.code}\nMismatch: /away deny ${this.code}`,
      0,
      0,
    ).render(width);
  }
  describe(cx: DescribeContext): NativeNode {
    if (!this.#styled) this.#styled = applyAwayStyles(cx);
    return awayBlock(
      cx,
      {
        role: "away.pairing.compare",
        title: "Pair phone",
        target: "Verify device",
        status: "pending",
      },
      [
        col(
          [
            text("Compare all 12 emojis, in order, with your phone.", { wrap: "word" }),
            text(clean(this.emoji), { role: "away.comparison", wrap: "word" }),
            text([span("Only approve if every emoji matches. Expires in 2 minutes.", "muted")], {
              wrap: "word",
            }),
            row(
              [
                node("button", {
                  role: "omp.btn",
                  text: "Deny",
                  variant: "quiet",
                  size: "sm",
                  actions: { click: "deny" },
                }),
                node("button", {
                  role: "omp.btn",
                  text: "All 12 match",
                  variant: "default",
                  size: "sm",
                  actions: { click: "approve" },
                }),
              ],
              { role: "away.footer", gap: "sm", wrap: true },
            ),
          ],
          { gap: "sm" },
        ),
      ],
    );
  }
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action" && (event.act === "approve" || event.act === "deny"))
      this.decide(event.act === "approve", this.code);
  }
}
