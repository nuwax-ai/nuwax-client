import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDesktopFeatures } from "../_kit/register";
import type { FeatureContext, FeatureHandle } from "../_kit/types";
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  closeAll: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));
vi.mock("./windows", () => ({ createBrowserWindows: mocks.create }));
import {
  browserFeature,
  createDesktopBrowserPage,
  isDesktopBrowserAvailable,
} from "./index";
let handle: FeatureHandle | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue({
    open: mocks.open,
    closeAll: mocks.closeAll,
    dispose: mocks.dispose,
  });
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
});
const context = () => ({
  settings: { read: vi.fn() },
  ipc: { handle: vi.fn(), dispose: vi.fn() },
  hostIpc: { handle: vi.fn(), dispose: vi.fn() },
  lifecycle: { onSessionEnd: vi.fn((_listener: () => void) => vi.fn()) },
});
describe("browser feature lifecycle", () => {
  it.each(["disabled", "other-product"])(
    "does not construct a context or browser runtime when %s",
    (mode) => {
      const createContext = vi.fn();
      const registered = registerDesktopFeatures([browserFeature], {
        product: mode === "other-product" ? "nuwaclaw" : "nuwax",
        isEnabled: () => mode !== "disabled",
        createContext,
        log: { info() {}, warn() {}, error() {} },
      });
      expect(registered.ids).toEqual([]);
      expect(createContext).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(isDesktopBrowserAvailable()).toBe(false);
    }
  );
  it("registers capabilities without opening a page, revokes on disable, and disposes resources", () => {
    const ctx = context();
    handle = browserFeature.register(ctx as unknown as FeatureContext);
    expect(isDesktopBrowserAvailable()).toBe(true);
    expect(mocks.open).not.toHaveBeenCalled();
    const end = ctx.lifecycle.onSessionEnd.mock
      .calls[0][0] as unknown as () => void;
    end();
    expect(mocks.closeAll).toHaveBeenCalledOnce();
    ctx.settings.read.mockReturnValue(false);
    expect(isDesktopBrowserAvailable()).toBe(false);
    expect(createDesktopBrowserPage({ windowOptions: {} })).toBeNull();
    handle.dispose();
    handle = undefined;
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(isDesktopBrowserAvailable()).toBe(false);
  });
  it("a failed registration leaves no browser capability and releases the runtime", () => {
    const ctx = context();
    ctx.hostIpc.handle.mockImplementation(() => {
      throw new Error("registration failure");
    });
    const registered = registerDesktopFeatures([browserFeature], {
      product: "nuwax",
      isEnabled: () => true,
      createContext: () => ctx as unknown as FeatureContext,
      log: { info() {}, warn() {}, error() {} },
    });
    expect(registered.ids).toEqual([]);
    expect(isDesktopBrowserAvailable()).toBe(false);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
