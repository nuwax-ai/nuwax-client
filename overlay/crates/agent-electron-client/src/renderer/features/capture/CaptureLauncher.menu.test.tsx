import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureCapabilities, CaptureMenuAction, CaptureState, HostCaptureBridge } from "@shared/features/capture/contract";

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
  Button: vi.fn(), Dropdown: vi.fn(), Modal: vi.fn(), Select: vi.fn(), Space: vi.fn(),
  message: { error: errors, success: vi.fn() },
}));
import { CaptureLauncher } from "./CaptureLauncher";

const capabilities = {
  available: true,
  formats: { still: ["png"], video: ["mp4", "webm"], gif: true },
} as CaptureCapabilities;

function mount(over: Partial<HostCaptureBridge> = {}) {
  let menu: ((action: CaptureMenuAction) => void) | undefined;
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
  CaptureLauncher({ capture, t: (key) => key });
  const cleanups = effects.map((effect) => effect());
  return { capture, menu: (action: CaptureMenuAction) => menu!(action), state: (next: CaptureState) => state!(next), offMenu, offState,
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()) };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => { effects.length = 0; errors.mockClear(); });

describe("宿主菜单与截图按钮共用 CaptureLauncher", () => {
  it("四种菜单命令使用现有截图/录制请求和当前质量，卸载清理订阅", async () => {
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

  it("特性不可用时如实提示 unsupported，菜单不发起截图", async () => {
    const ui = mount({ getCapabilities: vi.fn(async () => ({ ...capabilities, available: false })) });
    ui.menu("screenshot"); await flush();
    expect(ui.capture.screenshot).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("Claw.Capture.error.unsupported");
    ui.unmount();
  });
});
