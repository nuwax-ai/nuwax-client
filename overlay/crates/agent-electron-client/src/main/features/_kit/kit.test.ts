/**
 * 单元测试: _kit - 注册表、受信 IPC、生命周期事件、临时目录
 *
 * 覆盖：
 * - registerDesktopFeatures：产品过滤、开关（关闭/被运行期覆盖开启）、关闭零痕迹
 *   （register 与 createContext 均不被调用）、单个特性抛错不影响其他、
 *   逆序释放且释放抛错不中断、重复 id 报错
 * - createTrustedIpc：受信走处理函数；不受信得到兜底且处理函数不执行；重复通道报错；
 *   dispose 移除全部通道
 * - createFeatureLifecycle：订阅/退订、回调抛错互不影响、emitQuit 顺序执行
 * - createScratchDir：id 白名单（路径穿越被拒）、创建权限、resolve/remove、sweep 按 TTL
 */

import { describe, it, expect, vi } from "vitest";
import { createFeatureLifecycle } from "./lifecycle";
import { registerDesktopFeatures } from "./register";
import { createScratchDir, type ScratchFs } from "./scratchDir";
import { createTrustedIpc } from "./trustedIpc";
import type { DesktopFeature, FeatureContext } from "./types";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeContext(): FeatureContext {
  return {
    product: "nuwax",
    ipc: { handle: vi.fn(), dispose: vi.fn() },
    hostIpc: { handle: vi.fn(), dispose: vi.fn() },
    lifecycle: createFeatureLifecycle(),
    scratch: createScratchDir("/tmp/none", {} as ScratchFs),
    log,
  };
}

function feature(id: string, overrides: Partial<DesktopFeature> = {}): DesktopFeature {
  return {
    id,
    products: ["nuwax"],
    enabledByDefault: true,
    register: vi.fn(() => ({ dispose: vi.fn() })),
    ...overrides,
  };
}

describe("registerDesktopFeatures", () => {
  const deps = (over: Partial<Parameters<typeof registerDesktopFeatures>[1]> = {}) => ({
    product: "nuwax",
    isEnabled: (_id: string, def: boolean) => def,
    createContext: vi.fn(() => fakeContext()),
    log,
    ...over,
  });

  it("产品不匹配：整个特性不存在（register 与 createContext 都不调用）", () => {
    const f = feature("capture", { products: ["nuwaclaw"] });
    const d = deps();
    const out = registerDesktopFeatures([f], d);
    expect(out.ids).toEqual([]);
    expect(f.register).not.toHaveBeenCalled();
    expect(d.createContext).not.toHaveBeenCalled();
  });

  it("关闭即零痕迹：register 与 createContext 都不调用", () => {
    const f = feature("capture", { enabledByDefault: false });
    const d = deps();
    const out = registerDesktopFeatures([f], d);
    expect(out.ids).toEqual([]);
    expect(f.register).not.toHaveBeenCalled();
    expect(d.createContext).not.toHaveBeenCalled();
  });

  it("运行期覆盖可以开启默认关闭的特性，也可以关闭默认开启的特性", () => {
    const off = feature("a", { enabledByDefault: false });
    const on = feature("b", { enabledByDefault: true });
    const out = registerDesktopFeatures([off, on], deps({ isEnabled: (id) => id === "a" }));
    expect(out.ids).toEqual(["a"]);
  });

  it("单个特性注册抛错：记录并跳过，其余照常注册", () => {
    const bad = feature("bad", {
      register: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const good = feature("good");
    const out = registerDesktopFeatures([bad, good], deps());
    expect(out.ids).toEqual(["good"]);
    expect(log.error).toHaveBeenCalled();
  });

  it("逆序释放，某个释放抛错不中断其余", async () => {
    const order: string[] = [];
    const mk = (id: string, throws = false) =>
      feature(id, {
        register: () => ({
          dispose: () => {
            order.push(id);
            if (throws) throw new Error("dispose failed");
          },
        }),
      });
    const out = registerDesktopFeatures([mk("a"), mk("b", true), mk("c")], deps());
    await out.dispose();
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("读开关抛错：回落到清单默认值，其余特性不受影响", () => {
    const a = feature("a", { enabledByDefault: true });
    const b = feature("b", { enabledByDefault: false });
    const out = registerDesktopFeatures([a, b], deps({
      isEnabled: () => {
        throw new Error("db not ready");
      },
    }));
    expect(out.ids).toEqual(["a"]);
    expect(log.warn).toHaveBeenCalled();
  });

  it("重复 id 属于编程错误，直接抛出", () => {
    expect(() => registerDesktopFeatures([feature("x"), feature("x")], deps())).toThrow(
      /Duplicate desktop feature id/,
    );
  });
});

describe("createTrustedIpc", () => {
  function setup(trusted: boolean) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    };
    const ipc = createTrustedIpc<{ id: number }>(ipcMain as never, () => trusted);
    return { handlers, ipcMain, ipc };
  }

  it("受信 sender：执行处理函数并透传参数", async () => {
    const { handlers, ipc } = setup(true);
    const fn = vi.fn(async (_e: { id: number }, a: number) => a * 2);
    ipc.handle("x:double", fn, -1);
    expect(await handlers.get("x:double")!({ id: 1 }, 21)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("不受信 sender：得到兜底结果，处理函数不执行", async () => {
    const { handlers, ipc } = setup(false);
    const fn = vi.fn(async () => "secret");
    ipc.handle("x:read", fn, "denied");
    expect(await handlers.get("x:read")!({ id: 1 })).toBe("denied");
    expect(fn).not.toHaveBeenCalled();
  });

  it("同一实例重复注册同一通道报错", () => {
    const { ipc } = setup(true);
    ipc.handle("x:a", () => 1, 0);
    expect(() => ipc.handle("x:a", () => 1, 0)).toThrow(/already registered/);
  });

  it("dispose 移除本实例注册的全部通道", () => {
    const { handlers, ipcMain, ipc } = setup(true);
    ipc.handle("x:a", () => 1, 0);
    ipc.handle("x:b", () => 1, 0);
    ipc.dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(2);
    expect(handlers.size).toBe(0);
  });
});

describe("createFeatureLifecycle", () => {
  it("订阅、退订，回调抛错不影响其他回调", () => {
    const onError = vi.fn();
    const lc = createFeatureLifecycle(onError);
    const a = vi.fn(() => {
      throw new Error("a");
    });
    const b = vi.fn();
    lc.onSessionEnd(a);
    const off = lc.onSessionEnd(b);
    lc.emitSessionEnd("logout");
    expect(a).toHaveBeenCalledWith("logout");
    expect(b).toHaveBeenCalledWith("logout");
    expect(onError).toHaveBeenCalledTimes(1);
    off();
    lc.emitSessionEnd("switch-domain");
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("emitQuit 依次等待，某个失败不中断后续", async () => {
    const order: string[] = [];
    const onError = vi.fn();
    const lc = createFeatureLifecycle(onError);
    lc.onQuit(async () => {
      order.push("1");
    });
    lc.onQuit(() => {
      throw new Error("x");
    });
    lc.onQuit(async () => {
      order.push("3");
    });
    await lc.emitQuit();
    expect(order).toEqual(["1", "3"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("createScratchDir", () => {
  /** 路径分隔符归一，Windows 下 path.join 产出反斜杠也能命中以 posix 书写的夹具。 */
  const norm = (p: string) => p.replace(/\\/g, "/");

  function memFs(entries: Record<string, { mtimeMs: number }> = {}) {
    const dirs = new Map(Object.entries(entries));
    const fs: ScratchFs = {
      mkdirSync: vi.fn((p: string) => {
        dirs.set(norm(p), { mtimeMs: 0 });
      }),
      readdirSync: vi.fn(() => [...dirs.keys()].map((p) => p.split("/").pop()!)),
      statSync: vi.fn((p: string) => ({ mtimeMs: dirs.get(norm(p))!.mtimeMs, isDirectory: () => true })),
      rmSync: vi.fn((p: string) => {
        dirs.delete(norm(p));
      }),
      existsSync: vi.fn((p: string) => dirs.has(norm(p)) || norm(p) === "/scratch"),
    };
    return { fs, dirs };
  }

  it("id 白名单：路径穿越与非法字符被拒", () => {
    const { fs } = memFs();
    const s = createScratchDir("/scratch", fs);
    for (const bad of ["../etc", "a/b", "short", "x".repeat(65), "", "has space123"]) {
      expect(s.isValidId(bad)).toBe(false);
      expect(() => s.create(bad)).toThrow();
      expect(s.resolve(bad)).toBeNull();
    }
    expect(s.isValidId("abcDEF12_-xyz")).toBe(true);
  });

  it("create 以 0700 创建；resolve 只返回已存在目录；remove 删除", () => {
    const { fs } = memFs();
    const s = createScratchDir("/scratch", fs);
    const dir = s.create("result-0001");
    expect(fs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(s.resolve("result-0001")).toBe(dir);
    expect(s.resolve("result-0002")).toBeNull();
    s.remove("result-0001");
    expect(s.resolve("result-0001")).toBeNull();
  });

  it("sweep 只清理超过 TTL 的合法子目录", () => {
    const { fs, dirs } = memFs({
      "/scratch/old-result1": { mtimeMs: 1_000 },
      "/scratch/new-result1": { mtimeMs: 9_500 },
      "/scratch/.hidden": { mtimeMs: 0 },
    });
    const s = createScratchDir("/scratch", fs, () => 10_000);
    expect(s.sweep(1_000)).toBe(1);
    expect(dirs.has("/scratch/old-result1")).toBe(false);
    expect(dirs.has("/scratch/new-result1")).toBe(true);
    expect(dirs.has("/scratch/.hidden")).toBe(true);
  });
});
