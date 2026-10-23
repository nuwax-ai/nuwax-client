import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  windows: [] as any[], handlers: new Map<string, (...args: any[]) => unknown>(),
  quit: undefined as (() => void) | undefined,
}));
vi.mock("electron", () => ({
  app: {
    getFileIcon: async () => ({ isEmpty: () => false, toDataURL: () => "icon" }),
    on: (_name: string, listener: () => void) => { mocks.quit = listener; },
    removeListener: vi.fn(),
  },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => unknown) => mocks.handlers.set(name, fn),
    removeHandler: (name: string) => mocks.handlers.delete(name),
  },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
  BrowserWindow: class {
    destroyed = false;
    visible = false;
    listeners = new Map<string, () => void>();
    webContents = { mainFrame: { url: "" }, send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() };
    loadResolve!: () => void;
    constructor(public options: unknown) { mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.visible = false; }
    hide() { this.visible = false; }
    showInactive() { this.visible = true; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadURL(url: string) { this.webContents.mainFrame.url = url; return new Promise<void>(resolve => { this.loadResolve = resolve; }); }
  },
}));
vi.mock("electron-log", () => ({ default: { warn: vi.fn() } }));
import { createPermissionDragChip, permissionDragChipHtml } from "./permissionDragChip";

const labels = {
  dragChipTitle: 'Drop <into> "System Settings"',
  dragChipHint: "Drag the {0} icon into the app list",
  dragChipManual: "Dragging is unavailable",
};
describe("permission drag chip window html", () => {
  const html = permissionDragChipHtml(labels);
  it("escapes injected labels and keeps the interpolation slot client-side", () => {
    expect(html).toContain("Drag the {0} icon");
    expect(html).not.toContain("Drop <into>");
    expect(html).toContain("\\u003cinto>");
  });
  it("ships a strict CSP with a per-instance script nonce", () => {
    expect(html).toMatch(
      /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-[0-9a-f]{32}'"/,
    );
    // once in the CSP header form, once in the script tag attribute form
    expect(html.match(/(nonce-|nonce=")[0-9a-f]{32}/g)).toHaveLength(2);
  });
  it("exposes one draggable chip plus keyboard and close affordances", () => {
    expect(html).toContain('id="chip" draggable="true"');
    expect(html).toContain('id="close"');
    expect(html).toContain("onkeydown");
    expect(html).toContain("api.drag()");
    expect(html).toContain("api.close()");
    expect(html).toContain("dragChipManual");
  });
});

function ownerWindow() {
  const listeners = new Map<string, () => void>();
  return {
    visible: true, minimized: false, destroyed: false,
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    isDestroyed() { return this.destroyed; },
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    removeListener: (event: string) => listeners.delete(event),
    emit: (event: string) => listeners.get(event)?.(),
    listeners,
  };
}
describe("permission chip ownership", () => {
  beforeEach(() => { mocks.windows.length = 0; mocks.handlers.clear(); mocks.quit = undefined; });
  const identity = { key: "file_access" as const, appName: "Nuwax", appPath: "/Applications/Nuwax.app" };
  it("follows hide, minimize, restore and close without activating its owner", async () => {
    const owner = ownerWindow();
    const chip = createPermissionDragChip({ t: key => key, getWindow: () => owner as any });
    expect(chip.show(identity)).toBe(true);
    const window = mocks.windows[0];
    expect(window.options).toMatchObject({ parent: owner, focusable: false });
    window.loadResolve();
    await Promise.resolve();
    expect(window.visible).toBe(true);
    // Hide fires before Electron updates isVisible.
    owner.emit("hide");
    expect(window.visible).toBe(false);
    owner.emit("show");
    expect(window.visible).toBe(true);
    owner.emit("minimize");
    expect(window.visible).toBe(false);
    owner.emit("restore");
    expect(window.visible).toBe(true);
    owner.emit("close");
    expect(window.visible).toBe(false);
    chip();
    expect(owner.listeners.size).toBe(0);
  });
  it("does not resurrect after explicit hide or owner hide while load is pending", async () => {
    const owner = ownerWindow();
    const chip = createPermissionDragChip({ t: key => key, getWindow: () => owner as any });
    chip.show(identity);
    const window = mocks.windows[0];
    chip.hide();
    window.loadResolve();
    await Promise.resolve();
    owner.emit("show");
    expect(window.visible).toBe(false);
    chip.show(identity);
    expect(window.visible).toBe(true);
    owner.emit("hide");
    expect(window.visible).toBe(false);
    chip();
  });
  it("quit disposes a pending chip and prevents both late load and future show", async () => {
    const owner = ownerWindow();
    const chip = createPermissionDragChip({ t: key => key, getWindow: () => owner as any });
    chip.show(identity);
    const window = mocks.windows[0];
    mocks.quit!();
    window.loadResolve();
    await Promise.resolve();
    expect(window.destroyed).toBe(true);
    expect(window.visible).toBe(false);
    expect(chip.show(identity)).toBe(false);
    expect(mocks.handlers.size).toBe(0);
  });
  it("refuses to create a chip without a live main window", () => {
    const chip = createPermissionDragChip({ t: key => key, getWindow: () => null });
    expect(chip.show(identity)).toBe(false);
    expect(mocks.windows).toHaveLength(0);
    chip();
  });
});
