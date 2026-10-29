import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), load: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: () => mocks.load }));
vi.mock("electron-log", () => ({ default: { warn: vi.fn() } }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  mocks.load.mockReturnValue({ systemSettingsWindow: mocks.read });
});
afterEach(() => Object.defineProperty(process, "platform", platform));
describe("System Settings geometry", () => {
  it("returns only valid bounds without launching applications or requesting permission", async () => {
    mocks.read.mockReturnValue({ x: -1200, y: 50, width: 800, height: 650 });
    const { readSystemSettingsWindow } = await import("./macSystemSettingsWindow");
    expect(readSystemSettingsWindow()).toEqual({ x: -1200, y: 50, width: 800, height: 650 });
    mocks.read.mockReturnValue(null);
    expect(readSystemSettingsWindow()).toBeNull();
    mocks.read.mockReturnValue({ x: 0, y: 0, width: NaN, height: 600 });
    expect(readSystemSettingsWindow()).toBeNull();
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the native reader is unavailable", async () => {
    mocks.load.mockImplementation(() => { throw Error("unavailable"); });
    const { readSystemSettingsWindow } = await import("./macSystemSettingsWindow");
    expect(readSystemSettingsWindow()).toBeNull(); expect(readSystemSettingsWindow()).toBeNull();
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
  it("does not load a macOS addon on other platforms", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { readSystemSettingsWindow } = await import("./macSystemSettingsWindow");
    expect(readSystemSettingsWindow()).toBeNull(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("anchors inside the settings window and clamps to its display, including negative monitors", async () => {
    const { permissionChipPosition: position } = await import("./macSystemSettingsWindow");
    const size = { width: 384, height: 188 };
    const area = { x: 0, y: 0, width: 1440, height: 900 };
    expect(position({ x: 200, y: 100, width: 900, height: 700 }, area, size)).toEqual({ x: 700, y: 596 });
    expect(position({ x: -1300, y: 80, width: 800, height: 600 }, { ...area, x: -1440 }, size)).toEqual({ x: -900, y: 476 });
    expect(position({ x: 1300, y: 800, width: 900, height: 700 }, area, size)).toEqual({ x: 1056, y: 712 });
  });
});
