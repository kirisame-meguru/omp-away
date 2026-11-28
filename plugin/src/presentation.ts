import { UiNode, nativeSupports, signal, type JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { RenderResultOptions } from "@oh-my-pi/pi-coding-agent/tools/details/renderer";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Language } from "./language";
import { message } from "./messages";

export const clean = (value: string): string => replaceTabs(sanitizeText(value));
type Tone = "muted" | "success" | "warning" | "error";
type ToolRenderResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0];

/** Plain prose in OMP's native sans face, without interpreting external text as markup. */
function prose(value: string): UiNode {
  return new UiNode("md", {
    text: clean(value).replace(/[!-/:-@[-`{-~]/g, char => `&#${char.charCodeAt(0)};`)
      .replace(/^ +/gm, spaces => "&#32;".repeat(spaces.length)).replace(/\n/g, "  \n"),
  });
}

export function awayStatus(label: string, tone: Tone = "muted", icon?: string): UiNode {
  return new UiNode("row", {
    gap: "sm", align: "baseline", role: "away.status",
    children: [
      new UiNode("icon", { name: icon ?? (tone === "success" ? "check" : tone === "error" ? "x" : tone === "warning" ? "warn" : "clock"), tone }),
      new UiNode("text", { spans: [{ t: clean(label), s: tone }], wrap: "word" }),
    ],
  });
}

export function pairingExpiry(expiresAt: number, language: Language): UiNode {
  const remaining = signal(Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000)));
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "always" });
  const view = new UiNode("text", {
    role: "away.status",
    spans: () => [{ t: remaining() === 0 ? message(language, "Expired")
      : `${language === "ru" ? "Истекает" : "Expires"} ${relative.format(remaining(), "minute")}`, s: "muted" }],
  });
  const timer = setInterval(() => {
    remaining.set(Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000)));
    if (remaining() === 0) clearInterval(timer);
  }, 1000);
  timer.unref();
  view.onDispose(() => clearInterval(timer));
  return view;
}

export function awayBlock(
  props: { role: string; title: string; target?: string; status: "pending" | "done" | "error" | "cancelled"; collapsed?: boolean | (() => boolean); onToggle?: (collapsed: boolean) => void },
  children: JSXNode,
): UiNode {
  if (nativeSupports("tool")) return new UiNode("tool", {
    role: props.role, name: "away", title: props.title, target: props.target,
    targetKind: "text", status: props.status, frame: "card", preview: "children",
    collapsed: props.collapsed ?? false, onToggle: props.onToggle, children,
  });
  return new UiNode("card", {
    role: props.role,
    head: [{ t: props.title, s: "strong" }, ...(props.target ? [{ t: ` · ${props.target}` }] : [])],
    status: props.status, collapsible: props.collapsed !== undefined,
    collapsed: props.collapsed, onToggle: props.onToggle, preview: { lines: 6 }, children,
  });
}

function endCallBody(label: string, language: Language): UiNode {
  return prose(message(language, label));
}

export function createEndCallRenderers(language: () => Language = () => "en") {
  return {
    mergeCallAndResult: true,
    renderCall(_args: unknown, options: RenderResultOptions) {
      const waiting = options.executionStarted === false;
      return endCallBody(
        options.cancelled ? "Cancelled" : waiting ? "Waiting to end call" : "Ending call",
        language(),
      );
    },
    renderResult(result: ToolRenderResult, options: RenderResultOptions) {
      if (options.isPartial) return endCallBody("Ending call", language());
      if (result.isError) return endCallBody("Could not end call", language());
      return isRecord(result.details) && result.details.ended === true
        ? endCallBody("Call ended", language())
        : endCallBody("No matching active call", language());
    },
  };
}

export const endCallRenderers = createEndCallRenderers();

export function createCallRenderers(language: () => Language = () => "en") {
  const body = (label: string) => prose(message(language(), label));
  return {
    mergeCallAndResult: true,
    renderCall(_args: unknown, options: RenderResultOptions) {
      return body(options.cancelled ? "Cancelled" : options.executionStarted === false ? "Waiting to call" : "Calling phone");
    },
    renderResult(result: ToolRenderResult, options: RenderResultOptions) {
      if (options.cancelled) return body("Cancelled");
      if (options.isPartial) return body("Calling phone");
      if (result.isError) return body("Could not call phone");
      const labels: Record<string, string> = {
        armed: "Ready to call with the next question",
        answered: "Phone picked up", declined: "Call declined",
        missed: "Missed call", closed: "Question closed", unavailable: "Phone unavailable",
      };
      const outcome = isRecord(result.details) ? result.details.outcome : undefined;
      return body(typeof outcome === "string" ? labels[outcome] ?? "Call status unavailable" : "Call status unavailable");
    },
  };
}

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
    this.summary = message(language, result ? "Discussion received" : "Phone picked up");
    const detail = result ? data.voiceDiscussion : data.blockedWork;
    if (typeof detail === "string") this.detail = clean(detail);
    const id = result ? data.question : data.requestId;
    if (typeof id === "string") this.requestId = clean(id);
    // OMP styles direct prose sections of a tool body; a layout wrapper loses that typography.
    const children = () => [
      ...(this.detail ? [prose(this.shownDetail())] : []),
      ...(this.expanded() && this.requestId ? [new UiNode("text", { spans: [{ t: `${message(this.language, "Request")}: `, s: "muted" }, { t: this.requestId, s: "mono muted" }], wrap: "word" })] : []),
    ];
    const disclosure = {
      role: "away.call-message", collapsible: true,
      collapsed: () => !this.expanded(), onToggle: (collapsed: boolean) => this.expanded.set(!collapsed),
    };
    this.view = nativeSupports("tool")
      ? new UiNode("tool", {
        ...disclosure, name: "away", title: this.title, target: this.target, targetKind: "text",
        // This is a received event, not the state of the call or its question.
        status: "done", note: this.summary, frame: "card", preview: "children", children,
      })
      : new UiNode("card", {
        ...disclosure, head: [{ t: this.title, s: "strong" }, { t: ` · ${this.target}` }],
        preview: { lines: 6 }, children: [children, awayStatus(this.summary, "muted", "info")],
      });
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
    const panel = awayBlock({ role: "away.pairing.compare", title: message(language, "Pair phone"), status: "pending" }, [
      new UiNode("text", { text: message(language, "Compare all 12 emojis, in order, with your phone."), wrap: "word" }),
      new UiNode("text", { text: clean(emoji), role: "away.comparison", wrap: "word" }),
      pairingExpiry(Date.now() + 120_000, language),
      new UiNode("row", { role: "away.footer", gap: "sm", wrap: true, children: [
        new UiNode("button", { role: "omp.btn", text: message(language, "Deny"), variant: "quiet", size: "sm", actions: { click: "deny" }, onAction: (act: string) => { if (act === "deny") decide(false, code); } }),
        new UiNode("button", { role: "omp.btn", text: message(language, "All 12 match"), size: "sm", actions: { click: "approve" }, onAction: (act: string) => { if (act === "approve") decide(true, code); } }),
      ] }),
      () => nativeSupports("tool") ? null : new UiNode("text", { text: `${message(language, "Match")}: /away approve ${code}\n${message(language, "Mismatch")}: /away deny ${code}`, wrap: "word" }),
    ]);
    this.view = new UiNode("col", { role: "away.pairing.widget", children: panel });
  }
}
