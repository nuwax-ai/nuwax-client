import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureCapabilities, CaptureMenuAction, CaptureState, CaptureSuccess, HostCaptureBridge } from "@shared/features/capture/contract";

const { effects, errors } = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
  errors: vi.fn(),
}));

// Exercise the launcher's actual async request/listener flow without a DOM portal.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => undefined | (() => void)) => effects.push(effect),
}));
vi.mock("antd", () => ({
  Button: vi.fn(), Dropdown: vi.fn(),
  Modal: vi.fn(), Select: vi.fn(), Space: vi.fn(),
  message: { error: errors, success: vi.fn() },
}));
import { CaptureLauncher } from "./CaptureLauncher";

const capabilities = {
  available: true,
  formats: { still: ["png"], video: ["mp4", "webm"], gif: true },
} as CaptureCapabilities;

function mount(over: Partial<HostCaptureBridge> = {}, onCaptureStart?: () => Promise<void>) {
  type MenuHandler = (action: CaptureMenuAction) => void;
  let menu: ((action: CaptureMenuAction) => void) | undefined;
  let toolbarMenu: MenuHandler | null = null;
  let state: ((value: CaptureState) => void) | undefined;
  const offMenu = vi.fn();
  const offState = vi.fn();
  const capture = {
    getCapabilities: vi.fn(async () => capabilities),
    screenshot: vi.fn(async () => ({ success: false, code: "canceled" } as const)),
    record: vi.fn(async () => ({ success: false, code: "canceled" } as const)),
    cancel: vi.fn(), save: vi.fn(), readChunk: vi.fn(), release: vi.fn(),
    onMenuAction: vi.fn((listener) => { menu = listener; return offMenu; }),
    onStateChange: vi.fn((listener) => { state = listener; return offState; }),
    ...over,
  } as HostCaptureBridge;
  const onActionReady = vi.fn((handler: MenuHandler | null) => { toolbarMenu = handler; });
  CaptureLauncher({ capture, t: (key) => key, onCaptureStart, onActionReady });
  const cleanups = effects.map((effect) => effect());
  return { capture, menu: (action: CaptureMenuAction) => menu!(action), state: (next: CaptureState) => state!(next), offMenu, offState,
    toolbarMenu: (action: CaptureMenuAction) => toolbarMenu?.(action), onActionReady,
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()) };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => { effects.length = 0; errors.mockClear(); });

describe("宿主菜单与截图按钮共用 CaptureLauncher", () => {
  it.each(["screenshot", "mp4", "gif"] as const)("常驻控制器 %s 动作调用采集 API，不依赖 native 菜单事件", async (action) => {
    const ui = mount();
    ui.toolbarMenu(action); await flush();
    if (action === "screenshot") {
      expect(ui.capture.screenshot).toHaveBeenCalledOnce();
      expect(ui.capture.record).not.toHaveBeenCalled();
    } else {
      expect(ui.capture.record).toHaveBeenCalledOnce();
      expect(ui.capture.record).toHaveBeenCalledWith({ output: action, compression: { quality: "high" }, maxDurationMs: 300_000 });
      expect(ui.capture.screenshot).not.toHaveBeenCalled();
    }
    expect(ui.capture.onMenuAction).toHaveBeenCalledOnce();
    ui.unmount();
    expect(ui.onActionReady).toHaveBeenLastCalledWith(null);
    ui.toolbarMenu(action); await flush();
    expect(vi.mocked(ui.capture.screenshot).mock.calls.length + vi.mocked(ui.capture.record).mock.calls.length).toBe(1);
  });

  it("桥命令保留 WebM 兼容动作，卸载时注销入口", async () => {
    const ui = mount();
    for (const action of ["screenshot", "mp4", "webm", "gif"] as const) {
      ui.menu(action); await flush();
    }
    expect(ui.capture.screenshot).toHaveBeenCalledTimes(1);
    expect(ui.capture.screenshot).toHaveBeenCalledWith({ compression: { quality: "high" } });
    expect(vi.mocked(ui.capture.record).mock.calls.map(([value]) => value)).toEqual(
      ["mp4", "webm", "gif"].map(output => ({ output, compression: { quality: "high" }, maxDurationMs: 300_000 })),
    );
    ui.unmount();
    expect(ui.offMenu).toHaveBeenCalled();
    ui.menu("screenshot"); await flush();
    expect(ui.capture.screenshot).toHaveBeenCalledOnce();
  });

  it("Win/Linux 自绘菜单与原生菜单共用并发锁，保留产物等待预览保存", async () => {
    let finish!: (result: CaptureSuccess) => void;
    const screenshot = vi.fn(() => new Promise<CaptureSuccess>(resolve => { finish = resolve; }));
    const ui = mount({ screenshot });
    ui.toolbarMenu("screenshot"); ui.menu("mp4"); await flush();
    expect(screenshot).toHaveBeenCalledOnce();
    expect(ui.capture.record).not.toHaveBeenCalled();
    expect(errors).toHaveBeenLastCalledWith("Claw.Capture.error.busy");
    finish({ success: true, resultId: "menu-preview", mime: "image/png", bytes: 0, width: 40, height: 30, qualityUsed: "high", hdrToneMapped: false });
    await flush();
    expect(ui.capture.release).not.toHaveBeenCalled();
    ui.menu("gif"); await flush();
    expect(ui.capture.record).not.toHaveBeenCalled();
    expect(errors).toHaveBeenLastCalledWith("Claw.Capture.error.busy");
    ui.unmount();
    expect(ui.capture.release).toHaveBeenCalledTimes(1);
    expect(ui.capture.release).toHaveBeenCalledWith("menu-preview");
  });

  it("等待设置弹窗关闭才采集，面板关闭不卸载全局菜单控制器", async () => {
    let close!: () => void;
    const onStart = vi.fn(() => new Promise<void>(resolve => { close = resolve; }));
    const ui = mount({}, onStart);
    ui.menu("screenshot"); await flush();
    expect(onStart).toHaveBeenCalledOnce();
    expect(ui.capture.screenshot).not.toHaveBeenCalled();
    close(); await flush();
    expect(ui.capture.screenshot).toHaveBeenCalledOnce();
    ui.menu("mp4"); await flush(); close(); await flush();
    expect(ui.capture.record).toHaveBeenCalledOnce();
    expect(ui.offMenu).not.toHaveBeenCalled();
    ui.unmount(); expect(ui.offMenu).toHaveBeenCalledOnce();
  });
  it("包含 WebM 的兼容桥命令使用当前质量，卸载清理订阅", async () => {
    const ui = mount();
    ui.menu("screenshot"); await flush();
    expect(ui.capture.screenshot).toHaveBeenCalledWith({ compression: { quality: "high" } });
    for (const output of ["mp4", "webm", "gif"] as const) { ui.menu(output); await flush(); }
    expect(vi.mocked(ui.capture.record).mock.calls.map(([value]) => value)).toEqual(
      ["mp4", "webm", "gif"].map((output) => ({ output, compression: { quality: "high" }, maxDurationMs: 300_000 })),
    );
    expect(errors).not.toHaveBeenCalled();
    ui.unmount();
    expect(ui.offMenu).toHaveBeenCalledOnce();
    expect(ui.offState).toHaveBeenCalledOnce();
  });

  it("React 尚未重绘时连续菜单快捷键也不能发起第二次请求", async () => {
    let finish!: (value: { success: false; code: "canceled" }) => void;
    const screenshot = vi.fn(() => new Promise<{ success: false; code: "canceled" }>((resolve) => { finish = resolve; }));
    const ui = mount({ screenshot });
    ui.menu("screenshot"); ui.menu("mp4"); await flush();
    expect(screenshot).toHaveBeenCalledOnce();
    expect(ui.capture.record).not.toHaveBeenCalled();
    expect(errors).toHaveBeenLastCalledWith("Claw.Capture.error.busy");
    finish({ success: false, code: "canceled" }); await flush();
    ui.menu("mp4"); await flush();
    expect(ui.capture.record).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it.each(["selecting", "recording", "paused", "encoding"] as const)("当前发起方处于 %s 时如实报 busy", async (state) => {
    const ui = mount();
    ui.state(state); ui.menu("screenshot"); await flush();
    expect(ui.capture.screenshot).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("Claw.Capture.error.busy");
    ui.unmount();
  });

  it.each(["mp4", "webm", "gif"] as const)("当前本机缺少 %s 编码器时不进入录制", async (output) => {
    const ui = mount({ getCapabilities: vi.fn(async (): Promise<CaptureCapabilities> => ({ ...capabilities, formats: { still: ["png"], video: [], gif: false } })) });
    ui.menu(output); await flush();
    expect(ui.capture.record).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("Claw.Capture.error.encoderUnavailable");
    ui.unmount();
  });

  it.each(["menu"] as const)("特性不可用时如实提示 unsupported，%s 不发起截图", async (entry) => {
    const ui = mount({ getCapabilities: vi.fn(async () => ({ ...capabilities, available: false })) });
    ui[entry]("screenshot"); await flush();
    expect(ui.capture.screenshot).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("Claw.Capture.error.unsupported");
    ui.unmount();
  });
});
