import { UiNode, signal, type JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { RenderResultOptions } from "@oh-my-pi/pi-coding-agent/tools/details/renderer";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Language } from "./language";
import { message } from "./messages";

export const clean = (value: string): string => replaceTabs(sanitizeText(value));
type Tone = "muted" | "success" | "warning" | "error";
type ToolRenderResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0];

export function awayStatus(label: string, tone: Tone = "muted", icon?: string): UiNode {
  return new UiNode("row", {
    gap: "sm", align: "baseline", role: "away.status",
    children: [
      new UiNode("icon", { name: icon ?? (tone === "success" ? "check" : tone === "error" ? "x" : tone === "warning" ? "warn" : "clock"), tone }),
      new UiNode("text", { spans: [{ t: clean(label), s: tone }], wrap: "word" }),
    ],
  });
}

export function awayBlock(
  props: { role: string; title: string; target?: string; status: "pending" | "done" | "error" | "cancelled"; collapsed?: boolean | (() => boolean); onToggle?: (collapsed: boolean) => void },
  children: JSXNode,
): UiNode {
  return new UiNode("card", {
    role: props.role,
    head: [{ t: props.title, s: "strong" }, ...(props.target ? [{ t: ` · ${props.target}` }] : [])],
    status: props.status, collapsible: props.collapsed !== undefined,
    collapsed: props.collapsed, onToggle: props.onToggle, preview: { lines: 6 }, children,
  });
}

function endCallBody(label: string, tone: Tone, detail: string, language: Language, icon?: string): UiNode {
  return new UiNode("col", {
    gap: "sm", role: "away.end-call",
    children: [awayStatus(message(language, label), tone, icon), new UiNode("text", { text: message(language, detail), wrap: "word" })],
  });
}

export function createEndCallRenderers(language: () => Language = () => "en") {
  return {
    mergeCallAndResult: true,
    renderCall(_args: unknown, options: RenderResultOptions) {
      const waiting = options.executionStarted === false;
      return endCallBody(
        options.cancelled ? "Cancelled" : waiting ? "Waiting to end call" : "Ending call",
        "muted",
        options.cancelled ? "Call termination was not confirmed." : waiting ? "Waiting for execution. Audio has not been stopped." : "Stopping handset audio and live mode…",
        language(), options.cancelled ? "x" : undefined,
      );
    },
    renderResult(result: ToolRenderResult, options: RenderResultOptions) {
      if (options.isPartial) return endCallBody("Ending call", "muted", "Stopping handset audio and live mode…", language());
      if (result.isError) return endCallBody("Could not end call", "error", "The call may still be active. Check live mode before retrying.", language());
      return isRecord(result.details) && result.details.ended === true
        ? endCallBody("Call ended", "success", "Audio stopped. This does not submit an answer or resolve a pending form.", language())
        : endCallBody("No matching active call", "muted", "Nothing was ended in this session. Pending questions are unchanged.", language(), "info");
    },
  };
}

export const endCallRenderers = createEndCallRenderers();

/** The context envelope is model input, never transcript UI. */
export class CallMessage {
  readonly title: string;
  readonly target: string;
  readonly summary: string;
  readonly detail?: string;
  readonly requestId?: string;
  readonly expanded = signal(false);
  readonly view: UiNode;
  constructor(content: string, readonly result: boolean, expanded: boolean, readonly language: Language = "en") {
    this.expanded.set(expanded);
    let data: Record<string, unknown> = {};
    try {
      const source = result ? content : content.slice(content.lastIndexOf('\n{"requestId":') + 1).replace(/\n<\/omp-away-plugin>\s*$/, "");
      const parsed: unknown = JSON.parse(source);
      if (isRecord(parsed)) data = parsed;
    } catch {
      /* Unknown messages get a safe summary, not a raw payload. */
    }
    this.title = message(language, result ? "Voice discussion" : "Continue by voice");
    this.target = typeof data.title === "string" ? clean(data.title) : "Away";
    this.summary = message(language, result ? "Discussion returned to the agent" : "Phone picked up · pickup is not an answer");
    const detail = result ? data.voiceDiscussion : data.blockedWork;
    if (typeof detail === "string") this.detail = clean(detail);
    const id = result ? data.question : data.requestId;
    if (typeof id === "string") this.requestId = clean(id);
    this.view = awayBlock({
      role: "away.call-message", title: this.title, target: this.target, status: "done",
      collapsed: () => !this.expanded(), onToggle: collapsed => this.expanded.set(!collapsed),
    }, new UiNode("col", {
      role: "away.receipt", gap: "sm",
      children: () => [
        ...(this.detail ? [new UiNode("text", { text: this.shownDetail(), wrap: "word" })] : []),
        awayStatus(this.summary, "muted", this.result ? "check" : "info"),
        ...(this.expanded() && this.requestId ? [new UiNode("text", { spans: [{ t: `${message(this.language, "Request")}: ${this.requestId}`, s: "muted" }], wrap: "word" })] : []),
      ],
    }));
  }
  setExpanded(expanded: boolean): void { this.expanded.set(expanded); }
  private shownDetail(): string {
    const detail = this.detail ?? "";
    return !this.expanded() && detail.length > 280 ? `${Array.from(detail).slice(0, 280).join("")}…` : detail;
  }
}

/** Every action stays bound to its original comparison code, including stale clicks. */
export class PairingComparison {
  readonly view: UiNode;
  constructor(readonly emoji: string, readonly code: string, readonly decide: (accept: boolean, code: string) => void, readonly language: Language = "en") {
    this.view = awayBlock({ role: "away.pairing.compare", title: message(language, "Pair phone"), target: message(language, "Verify device"), status: "pending" }, [
      new UiNode("text", { text: message(language, "Compare all 12 emojis, in order, with your phone."), wrap: "word" }),
      new UiNode("text", { text: clean(emoji), role: "away.comparison", wrap: "word" }),
      new UiNode("text", { spans: [{ t: message(language, "Only approve if every emoji matches. Expires in 2 minutes."), s: "muted" }], wrap: "word" }),
      new UiNode("row", { role: "away.footer", gap: "sm", wrap: true, children: [
        new UiNode("button", { role: "omp.btn", text: message(language, "Deny"), variant: "quiet", size: "sm", actions: { click: "deny" }, onAction: (act: string) => { if (act === "deny") decide(false, code); } }),
        new UiNode("button", { role: "omp.btn", text: message(language, "All 12 match"), size: "sm", actions: { click: "approve" }, onAction: (act: string) => { if (act === "approve") decide(true, code); } }),
      ] }),
      new UiNode("text", { text: `${message(language, "Match")}: /away approve ${code}\n${message(language, "Mismatch")}: /away deny ${code}`, wrap: "word" }),
    ]);
  }
}
