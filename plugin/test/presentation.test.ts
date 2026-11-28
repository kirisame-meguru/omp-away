import { expect, test } from "bun:test";
import { UiNode } from "@oh-my-pi/pi-tui";
import { setNativeRenderingForTest } from "@oh-my-pi/pi-tui/host";
import { getBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { CallMessage, PairingComparison, createEndCallRenderers } from "../src/presentation";
import { PairingQr } from "../src/runtime/pairing-qr";

function nodes(node: UiNode): UiNode[] {
  return [node, ...node.children().flatMap(nodes)];
}
function text(node: UiNode): string {
  return nodes(node).map(n => JSON.stringify(n.props())).join("\n");
}

test("call messages retain card fallback and disclosure without a misleading completion badge", () => {
  const detail = "x".repeat(300);
  const message = new CallMessage(`secret instructions\n${JSON.stringify({ requestId: "request-1", title: "Release", blockedWork: detail })}\n</omp-away-plugin>`, false, false);
  expect(message.view).toBeInstanceOf(UiNode);
  expect(message.view.kind).toBe("card");
  expect(message.view.props()).not.toHaveProperty("status");
  expect(text(message.view)).toContain("Phone picked up");
  expect(text(message.view)).not.toContain("pickup is not an answer");
  expect(text(message.view)).not.toContain("secret instructions");
  expect(text(message.view)).not.toContain("request-1");
  expect(text(message.view)).toContain("…");
  message.view.handlers.onToggle!(false, {} as never);
  expect(text(message.view)).toContain(detail);
  expect(text(message.view)).toContain("request-1");
  message.setExpanded(false);
  expect(text(message.view)).not.toContain("request-1");
});

test("native voice receipts use OMP tool heads, prose, and event-specific status notes", () => {
  setNativeRenderingForTest(true);
  try {
    for (const result of [false, true]) {
      const detail = "Review the display. ".repeat(40);
      const content = result
        ? JSON.stringify({ question: "request-1", title: "Display", voiceDiscussion: detail })
        : `context\n${JSON.stringify({ requestId: "request-1", title: "Display", blockedWork: detail })}`;
      const message = new CallMessage(content, result, false);
      expect(message.view.kind).toBe("tool");
      expect(message.view.props()).toMatchObject({
        name: "away", targetKind: "text", preview: "children",
        note: result ? "Discussion received" : "Phone picked up",
      });
      expect(nodes(message.view).some(node => node.kind === "card")).toBe(false);
      expect(message.view.children()[0]!.kind).toBe("md");
      expect(text(message.view)).not.toContain("request-1");
      message.view.handlers.onToggle!(false, {} as never);
      expect(message.view.props()).toHaveProperty("collapsed", false);
      expect(text(message.view)).toContain("request-1");
      expect(nodes(message.view).find(node => node.kind === "md")!.props()).toHaveProperty("text", detail.replaceAll(".", "&#46;"));
      message.setExpanded(false);
      expect(text(message.view)).not.toContain("request-1");
    }
    const russian = new CallMessage('{"requestId":"request-2"}', false, false, "ru");
    expect(russian.view.props()).toHaveProperty("note", "Звонок принят");
  } finally {
    setNativeRenderingForTest(false);
  }
});

test("voice prose escapes markup rather than executing model-authored formatting", () => {
  const message = new CallMessage(JSON.stringify({
    question: "request-1", voiceDiscussion: "# Heading\n[link](https://example.com) <img> $math$",
  }), true, true);
  const body = nodes(message.view).find(node => node.kind === "md")!;
  expect(body.props()).toHaveProperty("text", "&#35; Heading  \n&#91;link&#93;&#40;https&#58;&#47;&#47;example&#46;com&#41; &#60;img&#62; &#36;math&#36;");
  const indented = new CallMessage(JSON.stringify({ voiceDiscussion: "    Not a code block" }), true, true);
  expect(nodes(indented.view).find(node => node.kind === "md")!.props()).toHaveProperty("text", "&#32;".repeat(4) + "Not a code block");
});

test("end-call phases use native nodes, including errors and pending execution", () => {
  const renderers = createEndCallRenderers();
  const options = { expanded: false, isPartial: false };
  expect(text(renderers.renderCall({}, { ...options, executionStarted: false }))).toContain("Waiting to end call");
  expect(renderers.renderCall({}, options).kind).toBe("md");
  expect(text(renderers.renderResult({ content: [], details: { ended: true } }, options))).toContain("Call ended");
  expect(text(renderers.renderResult({ content: [], isError: true }, options))).toContain("Could not end call");
  expect(text(renderers.renderResult({ content: [], details: { ended: false } }, options))).toContain("No matching active call");
  expect(text(renderers.renderResult({ content: [] }, { ...options, isPartial: true }))).toContain("Ending call");
  expect(text(renderers.renderCall({}, { ...options, cancelled: true }))).toContain("Cancelled");
  for (const ended of [true, false]) {
    const output = text(renderers.renderResult({ content: [], details: { ended } }, options));
    expect(output).not.toContain("submit");
    expect(output).not.toContain("Pending questions");
  }
});

test("comparison actions remain bound to their comparison code", () => {
  const answers: [boolean, string][] = [];
  const view = new PairingComparison("🐶".repeat(12), "abcdef123456", (accept, code) => answers.push([accept, code])).view;
  const buttons = nodes(view).filter(node => node.kind === "button");
  buttons[0]!.handlers.onAction!("unrelated", {} as never);
  buttons[0]!.handlers.onAction!("deny", {} as never);
  buttons[1]!.handlers.onAction!("approve", {} as never);
  expect(answers).toEqual([[false, "abcdef123456"], [true, "abcdef123456"]]);
});

test("pairing QR preserves native image, cancellation, and safe terminal fallback", () => {
  let cancelled = 0;
  const payload = "private-enrollment-payload";
  const qr = new PairingQr(payload, () => 100, () => cancelled++);
  expect(qr.render(10).join("\n")).toContain("QR cannot");
  expect(qr.render(100).join("\n")).toContain("Scan with Away");
  expect(qr.render(100).join("\n")).not.toContain(payload);
  setNativeRenderingForTest(true);
  try {
    const image = nodes(qr.view).find(node => node.kind === "image")!;
    expect(image).toBeDefined();
    const imageProps = image.props();
    if (!("blob" in imageProps) || typeof imageProps.blob !== "string") throw new Error("QR image has no blob");
    expect(getBlob(imageProps.blob)).toBeDefined();
    expect(text(qr.view)).not.toContain(payload);
    nodes(qr.view).find(node => node.kind === "button")!.handlers.onAction!("cancel-pair", {} as never);
    expect(cancelled).toBe(1);
  } finally {
    setNativeRenderingForTest(false);
  }
  expect(nodes(qr.view).some(node => node.kind === "canvas")).toBe(true);
});
