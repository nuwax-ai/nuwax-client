import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { taskPreviewWindowHtml } from "./taskPreviewWindow";

// Exercise the actual private-page script without launching Electron or a GUI.
class Element {
  children: Element[] = [];
  textContent = ""; innerHTML = ""; hidden = false; disabled = false; src = "";
  style = { setProperty: vi.fn() }; classList = { toggle: vi.fn() };
  handlers: Record<string, (event: any) => unknown> = {};
  onclick?: () => unknown;
  constructor(public tag = "div") {}
  append(child: Element) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  addEventListener(name: string, fn: (event: any) => unknown) { this.handlers[name] = fn; }
  setPointerCapture() {}
  closest(tag: string) { return tag === this.tag ? this : null; }
}
const task = (id: string) => ({ taskId: id, bindingId: id, epoch: 1, phase: "running", color: "#4f8cff",
  scope: { kind: "window", pid: 5, windowId: 6, label: "Editor " + id } });
async function page() {
  const html = taskPreviewWindowHtml(key => key), nodes = new Map<string, Element>();
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) nodes.set(match[2], new Element(match[1]));
  const header = new Element("header"), tasks = [task("A"), task("B")];
  let state = { revision: 1, tasks };
  let runtime!: (state: any) => void, preview!: (frame: any) => void;
  const api = {
    close: vi.fn(), move: vi.fn(async (position: any) => ({ position })), reorder: vi.fn(async () => {}),
    taskAction: vi.fn(async () => ({ success: true })), getRuntime: vi.fn(async () => state),
    getPresentation: vi.fn(async () => ({ taskId: "A", position: { x: 600, y: 72 } })),
    setPresentation: vi.fn(async (taskId: string) => ({ taskId })),
    onRuntime: (fn: typeof runtime) => { runtime = fn; }, onPreview: (fn: typeof preview) => { preview = fn; }, onPresentation: vi.fn(),
  };
  let sequence = 0;
  const urls = { createObjectURL: vi.fn(() => "blob:" + ++sequence), revokeObjectURL: vi.fn() };
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1], {
    window: { cuaControls: api, addEventListener: vi.fn() },
    document: { body: new Element(), getElementById: (id: string) => nodes.get(id),
      querySelector: () => header, createElement: (tag: string) => new Element(tag) },
    URL: urls, Blob, atob, Uint8Array, setInterval: vi.fn(),
  });
  await flush();
  return { html, api, urls, nodes, preview, update: (tasks: any[]) => { state = { revision: state.revision + 1, tasks }; runtime(state); } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const frame = (id: string, epoch = 1) => ({ taskId: id, status: "ready", frame: {
  bindingId: id, epoch, sequence: 1, capturedAt: Date.now(), jpeg: "aGVsbG8=",
} });
describe("small native window preview", () => {
  it("selects a back window and uses exact takeover while keeping execution details out of the card", async () => {
    const p = await page();
    await p.nodes.get("stack")!.children[0].onclick!();
    expect(p.api.setPresentation).toHaveBeenCalledWith("B");
    expect(p.api.reorder).toHaveBeenCalledWith(["B", "A"]);
    expect(p.api.taskAction).toHaveBeenCalledWith("B", "takeover");
    expect(p.html).not.toMatch(/<select|<article|id="toggle"|id="tasksPanel"/);
    expect(p.html).toContain(".shell:hover header"); expect(p.html).toContain(".shell:focus-within header");
  });
  it("drags the actual thumbnail without accidentally taking control, and closes only the preview", async () => {
    const p = await page(), viewport = p.nodes.get("viewport")!;
    viewport.handlers.pointerdown({ button: 0, pointerId: 1, screenX: 100, screenY: 100, target: viewport });
    viewport.handlers.pointermove({ pointerId: 1, screenX: 50, screenY: 130 });
    viewport.handlers.pointerup({ pointerId: 1 }); viewport.onclick!(); await flush();
    expect(p.api.move).toHaveBeenCalledWith({ x: 550, y: 102 });
    expect(p.api.taskAction).not.toHaveBeenCalled();
    p.nodes.get("close")!.onclick!(); expect(p.api.close).toHaveBeenCalledOnce();
    expect(p.api.taskAction).not.toHaveBeenCalled();
  });
  it("keeps stop usable during handoff and presents resume on a paused task", async () => {
    const p = await page(); p.update([{ ...task("A"), controlPending: true }]);
    expect(p.nodes.get("pause")!.disabled).toBe(true); expect(p.nodes.get("stop")!.disabled).toBe(false);
    await p.nodes.get("stop")!.onclick!(); expect(p.api.taskAction).toHaveBeenCalledWith("A", "stop");
    p.update([{ ...task("A"), phase: "paused" }]);
    expect(p.nodes.get("pause")!.hidden).toBe(true); expect(p.nodes.get("resume")!.hidden).toBe(false);
  });
  it("keeps stop on a draining task and shows a compact permission failure", async () => {
    const p = await page();
    p.update([{ ...task("A"), phase: "stopped", controlPending: true, reason: "userStopped" }]);
    expect(p.nodes.get("stop")!.disabled).toBe(false);
    expect(p.nodes.get("phase")!.textContent).toBe("Claw.Cua.preview.handoff");
    p.update([{ ...task("A"), phase: "paused", reason: "permissionsRequired" }]);
    expect(p.nodes.get("error")!.textContent).toBe("Claw.Cua.reason.permissionsRequired");
  });
  it("draws real back-window frames and clears cached pixels on revoke or rebind", async () => {
    const p = await page(); p.preview(frame("B"));
    expect(p.nodes.get("stack")!.children[0].children[0].src).toBe("blob:1");
    p.update([task("A"), { ...task("B"), epoch: 2 }]);
    expect(p.urls.revokeObjectURL).toHaveBeenCalledWith("blob:1");
    p.preview(frame("B")); expect(p.urls.createObjectURL).toHaveBeenCalledTimes(1);
    p.preview(frame("A")); expect(p.nodes.get("image")!.hidden).toBe(false);
    p.update([{ ...task("A"), controlPending: true }]);
    expect(p.nodes.get("image")!.hidden).toBe(true);
  });
  it("escapes translated text before embedding it in the nonce script", () => {
    const html = taskPreviewWindowHtml(() => '</script><img src="unsafe">');
    expect(html.match(/<script\b/g)).toHaveLength(1); expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img src="unsafe">');
  });
});

it("selects a draining task for retry-stop without native takeover", async () => {
  const p = await page();
  p.update([task("A"), { ...task("B"), phase: "stopped", controlPending: true }]);
  await p.nodes.get("stack")!.children[0].onclick!();
  expect(p.api.setPresentation).toHaveBeenCalledWith("B");
  expect(p.api.taskAction).not.toHaveBeenCalled();
});

it("confirms only the selected task through the private preview channel", async () => {
  const p = await page(); p.update([{ ...task("A"), phase: "paused", reason: "confirmationRequired" }]);
  expect(p.nodes.get("confirm")!.hidden).toBe(false);
  await p.nodes.get("confirm")!.onclick!();
  expect(p.api.taskAction).toHaveBeenCalledWith("A", "confirm");
});
