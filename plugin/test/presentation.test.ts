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

test("call messages return reactive cards without exposing the context envelope", () => {
  const detail = "x".repeat(300);
  const message = new CallMessage(`secret instructions\n${JSON.stringify({ requestId: "request-1", title: "Release", blockedWork: detail })}\n</omp-away-plugin>`, false, false);
  expect(message.view).toBeInstanceOf(UiNode);
  expect(message.view.kind).toBe("card");
  expect(text(message.view)).not.toContain("secret instructions");
  expect(text(message.view)).not.toContain("request-1");
  expect(text(message.view)).toContain("…");
  message.view.handlers.onToggle!(false, {} as never);
  expect(text(message.view)).toContain(detail);
  expect(text(message.view)).toContain("request-1");
  message.setExpanded(false);
  expect(text(message.view)).not.toContain("request-1");
});

test("end-call phases use native nodes, including errors and pending execution", () => {
  const renderers = createEndCallRenderers();
  const options = { expanded: false, isPartial: false };
  expect(text(renderers.renderCall({}, { ...options, executionStarted: false }))).toContain("Waiting to end call");
  expect(text(renderers.renderResult({ content: [], details: { ended: true } }, options))).toContain("Call ended");
  expect(text(renderers.renderResult({ content: [], isError: true }, options))).toContain("Could not end call");
  expect(text(renderers.renderResult({ content: [], details: { ended: false } }, options))).toContain("No matching active call");
  expect(text(renderers.renderResult({ content: [] }, { ...options, isPartial: true }))).toContain("Ending call");
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
