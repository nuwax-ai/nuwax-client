import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  changed: undefined as undefined | ((revision: number) => void),
  resolve: undefined as undefined | (() => void),
  snapshot: { revision: 1, mode: "light" },
}));
vi.mock("electron", () => ({
  dialog: {},
  shell: {},
  nativeTheme: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("./service", () => ({
  ThemeService: class {
    ready = new Promise<void>((resolve) => {
      h.resolve = resolve;
    });
    constructor(_directory: string, deps: { changed: typeof h.changed }) {
      h.changed = deps.changed;
    }
    state() {
      return { snapshot: h.snapshot };
    }
    dispose = vi.fn();
  },
  watchThemeDirectory: vi.fn(),
  themeError: vi.fn(),
}));
import {
  ThemesRuntime,
  getDesktopThemeSnapshot,
  subscribeDesktopThemeSnapshot,
} from "./index";
it("supports browser registration before theme readiness, then updates and unsubscribes", async () => {
  const chrome = vi.fn();
  expect(getDesktopThemeSnapshot()).toBeNull();
  const unsubscribe = subscribeDesktopThemeSnapshot(chrome);
  const runtime = new ThemesRuntime({
    dataDir: "unused",
    ipc: { handle: vi.fn(), dispose: vi.fn() },
    hostIpc: { handle: vi.fn(), dispose: vi.fn() },
    windows: { getMain: () => null },
    settings: { write: vi.fn() },
    log: { warn: vi.fn() },
  } as never);
  expect(chrome).not.toHaveBeenCalled();
  h.resolve!();
  await Promise.resolve();
  expect(chrome).toHaveBeenCalledOnce();
  expect(getDesktopThemeSnapshot()).toEqual(h.snapshot);
  h.snapshot = { revision: 2, mode: "dark" };
  h.changed!(2);
  expect(chrome).toHaveBeenCalledTimes(2);
  expect(getDesktopThemeSnapshot()).toEqual(h.snapshot);
  unsubscribe();
  await runtime.dispose();
  expect(getDesktopThemeSnapshot()).toBeNull();
  expect(chrome).toHaveBeenCalledTimes(2);
  h.changed!(3);
  expect(getDesktopThemeSnapshot()).toBeNull();
});
