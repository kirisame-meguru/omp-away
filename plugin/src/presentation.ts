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
import type { Language } from "./language";
import { message } from "./messages";

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
    readonly language: Language = "en",
  ) {}
  render(width: number): readonly string[] {
    return new Text(`${message(this.language, this.label)}\n${message(this.language, this.detail)}`, 0, 0).render(width);
  }
  describe(cx: DescribeContext): NativeNode {
    if (!this.#styled) this.#styled = applyAwayStyles(cx);
    return col(
      [awayStatus(message(this.language, this.label), this.tone, this.icon), text(message(this.language, this.detail), { wrap: "word" })],
      { gap: "sm", role: "away.end-call" },
    );
  }
}

function endCallBody(result: ToolRenderResult, options: RenderResultOptions, language: Language = "en"): EndCallBody {
  if (options.isPartial)
    return new EndCallBody("Ending call", "muted", "Stopping handset audio and live mode…", undefined, language);
  if (result.isError)
    return new EndCallBody(
      "Could not end call",
      "error",
      "The call may still be active. Check live mode before retrying.",
      undefined, language,
    );
  const ended = isRecord(result.details) && result.details.ended === true;
  return ended
    ? new EndCallBody(
        "Call ended",
        "success",
        "Audio stopped. This does not submit an answer or resolve a pending form.",
        undefined, language,
      )
    : new EndCallBody(
        "No matching active call",
        "muted",
        "Nothing was ended in this session. Pending questions are unchanged.",
        "info",
        language,
      );
}

export function createEndCallRenderers(language: () => Language = () => "en") {
  return {
  mergeCallAndResult: true,
  renderCall() {
    return new Text(`${message(language(), "End call")} · Away`, 0, 0);
  },
  renderResult(result: ToolRenderResult, options: RenderResultOptions) {
    return endCallBody(result, options, language());
  },
  describeCall(_args: unknown, options: RenderResultOptions): NativeToolView {
    const waiting = options.executionStarted === false;
    return {
      tool: { title: message(language(), "End call"), target: "Away", targetKind: "text" },
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
          language(),
        ),
      ],
      preview: "children",
    };
  },
  describeResult(result: ToolRenderResult, options: RenderResultOptions): NativeToolView {
    return {
      tool: { title: message(language(), "End call"), target: "Away", targetKind: "text" },
      inline: false,
      body: [endCallBody(result, options, language())],
      preview: "children",
    };
  },
  };
}

export const endCallRenderers = createEndCallRenderers();

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
    readonly language: Language = "en",
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
    this.title = message(language, result ? "Voice discussion" : "Continue by voice");
    this.target = typeof data.title === "string" ? clean(data.title) : "Away";
    this.summary = message(language, result
      ? "Discussion returned to the agent"
      : "Phone picked up · pickup is not an answer");
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
        ...(this.expanded && this.requestId ? [`${message(this.language, "Request")}: ${this.requestId}`] : []),
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
              ? [text([span(`${message(this.language, "Request")}: ${this.requestId}`, "muted")], { wrap: "word" })]
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
    readonly language: Language = "en",
  ) {}
  render(width: number): readonly string[] {
    return new Text(
      `${message(this.language, "Pair phone")} · Away\n${message(this.language, "Compare all 12 emojis on your phone:")}\n${clean(this.emoji)}\n${message(this.language, "Only approve if every emoji matches. Expires in 2 minutes.")}\n${message(this.language, "Match")}: /away approve ${this.code}\n${message(this.language, "Mismatch")}: /away deny ${this.code}`,
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
        title: message(this.language, "Pair phone"),
        target: message(this.language, "Verify device"),
        status: "pending",
      },
      [
        col(
          [
            text(message(this.language, "Compare all 12 emojis, in order, with your phone."), { wrap: "word" }),
            text(clean(this.emoji), { role: "away.comparison", wrap: "word" }),
            text([span(message(this.language, "Only approve if every emoji matches. Expires in 2 minutes."), "muted")], {
              wrap: "word",
            }),
            row(
              [
                node("button", {
                  role: "omp.btn",
                  text: message(this.language, "Deny"),
                  variant: "quiet",
                  size: "sm",
                  actions: { click: "deny" },
                }),
                node("button", {
                  role: "omp.btn",
                  text: message(this.language, "All 12 match"),
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
