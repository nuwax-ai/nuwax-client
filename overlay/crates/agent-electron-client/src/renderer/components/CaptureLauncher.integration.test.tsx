import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureCapabilities, CaptureMenuAction, HostCaptureBridge } from "@shared/features/capture/contract";
import { CaptureLauncher } from "../features/capture";

const { effects, toolbarItems } = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
  toolbarItems: [] as Array<{ key?: string; onClick?: () => void }>,
}));

// Integration belongs to the shell: features only expose their public entry.
// Keep production toolbar/controller async behavior without DOM portals.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => undefined | (() => void)) => effects.push(effect),
}));
vi.mock("antd", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Dropdown: ({ children, menu }: { children: React.ReactNode; menu: { items: typeof toolbarItems } }) => {
    toolbarItems.push(...menu.items);
    return children;
  },
  Modal: vi.fn(), InputNumber: vi.fn(), Select: vi.fn(), Space: vi.fn(),
  message: { error: vi.fn(), success: vi.fn() },
}));

const capabilities = {
  available: true,
  formats: { still: ["png"], video: ["mp4", "webm"], gif: true },
} as CaptureCapabilities;

function mount() {
  let controllerAction: ((action: CaptureMenuAction) => void) | null = null;
  const capture = {
    getCapabilities: vi.fn(async () => capabilities),
    screenshot: vi.fn(async () => ({ success: false, code: "canceled" } as const)),
    record: vi.fn(async () => ({ success: false, code: "canceled" } as const)),
    cancel: vi.fn(), save: vi.fn(), readChunk: vi.fn(), release: vi.fn(),
    onMenuAction: vi.fn(() => vi.fn()),
    onStateChange: vi.fn(() => vi.fn()),
  } as HostCaptureBridge;
  const onActionReady = vi.fn((handler: ((action: CaptureMenuAction) => void) | null) => { controllerAction = handler; });
  CaptureLauncher({ capture, t: key => key, onActionReady });
  const cleanups = effects.map(effect => effect());
  return {
    capture, onActionReady,
    onCapture: (action: CaptureMenuAction) => controllerAction?.(action),
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}

const paintFrames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const paint = () => {
  const callbacks = [...paintFrames.values()];
  paintFrames.clear();
  callbacks.forEach(callback => callback(0));
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
  effects.length = 0; toolbarItems.length = 0;
  paintFrames.clear(); frameId = 0;
  vi.stubGlobal("window", { electronAPI: { on: vi.fn(), off: vi.fn(), window: { isMaximized: vi.fn(async () => false) } } });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    paintFrames.set(++frameId, callback);
    return frameId;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => paintFrames.delete(id)));
});
afterEach(() => vi.unstubAllGlobals());

describe("壳菜单与原生采集控制器集成", () => {
  it.each([
    ["Win32", "screenshot"], ["Win32", "mp4"], ["Win32", "gif"],
    ["Linux x86_64", "screenshot"], ["Linux x86_64", "mp4"], ["Linux x86_64", "gif"],
  ] as const)("%s 应用菜单默认显示时，宿主动作 %s 仍调用采集 API", async (platform, action) => {
    vi.stubGlobal("navigator", { platform });
    const ui = mount();
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    renderToStaticMarkup(<TrafficLightToolbar menuCollapsed={false} menuAvailable
      canGoBack={false} canGoForward={false} onToggleMenu={vi.fn()} onBack={vi.fn()}
      onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()} captureAvailable onCapture={ui.onCapture} />);
    expect(toolbarItems.some(item => item.key?.startsWith("capture-"))).toBe(true);
    vi.mocked(ui.capture.onMenuAction!).mock.calls[0][0](action);
    await flush();
    expect(action === "screenshot" ? ui.capture.screenshot : ui.capture.record).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it.each([
    ["Win32", "screenshot"], ["Win32", "mp4"], ["Win32", "gif"],
    ["Linux x86_64", "screenshot"], ["Linux x86_64", "mp4"], ["Linux x86_64", "gif"],
  ] as const)("%s 菜单 %s 经常驻控制器调用采集 API", async (platform, action) => {
    vi.stubGlobal("navigator", { platform });
    const ui = mount();
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    renderToStaticMarkup(<TrafficLightToolbar menuCollapsed={false} menuAvailable
      canGoBack={false} canGoForward={false} onToggleMenu={vi.fn()} onBack={vi.fn()}
      onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()} captureMenuVisible captureAvailable onCapture={ui.onCapture} />);
    const item = toolbarItems.find(item => item.key === `capture-${action}`);
    expect(item?.onClick).toBeTypeOf("function");
    item!.onClick!();
    expect(ui.capture.screenshot).not.toHaveBeenCalled();
    expect(ui.capture.record).not.toHaveBeenCalled();
    paint(); paint(); await flush();
    if (action === "screenshot") {
      expect(ui.capture.screenshot).toHaveBeenCalledOnce();
      expect(ui.capture.record).not.toHaveBeenCalled();
    } else {
      expect(ui.capture.record).toHaveBeenCalledOnce();
      expect(ui.capture.record).toHaveBeenCalledWith({ output: action, compression: { quality: "high" }, maxDurationMs: 1_800_000 });
      expect(ui.capture.screenshot).not.toHaveBeenCalled();
    }
    expect(ui.capture.onMenuAction).toHaveBeenCalledOnce();
    ui.unmount();
    expect(ui.onActionReady).toHaveBeenLastCalledWith(null);
    ui.onCapture(action); await flush();
    expect(vi.mocked(ui.capture.screenshot).mock.calls.length + vi.mocked(ui.capture.record).mock.calls.length).toBe(1);
  });
});
