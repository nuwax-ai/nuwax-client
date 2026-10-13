/**
 * 单元测试: features/index - 注册表与运行时
 *
 * electron 整体 mock（特性清单文件会 import 它，但这里只验证运行时接线）。
 * 覆盖：真实注册表 id 唯一且含 capture / open-source-notices；按产品与开关过滤；
 * 上下文里有 ipc / hostIpc / 以 `<dataDir>/<id>` 为根的 scratch；重复启动幂等；
 * 登出/换域事件到达订阅者；退出时先发 quit 再逆序释放；关闭的特性零接触
 * （不注册 IPC、不创建上下文）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/app", getName: () => "Nuwax" },
  desktopCapturer: { getSources: vi.fn() },
  screen: { getAllDisplays: () => [], getDisplayNearestPoint: vi.fn(), getCursorScreenPoint: vi.fn() },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
}));

import {
  desktopFeatures,
  disposeDesktopFeatures,
  notifyFeatureSessionEnd,
  startDesktopFeatures,
  isDesktopFeatureRegistered,
  type StartFeaturesOptions,
} from "./index";
import type { DesktopFeature, FeatureContext } from "./_kit/types";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function options(over: Partial<StartFeaturesOptions> = {}): StartFeaturesOptions {
  return {
    product: "nuwax",
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    isBusinessSender: () => true,
    isHostSender: () => true,
    dataDir: "/home/u/.nuwax",
    isEnabled: (_id, def) => def,
    log,
    ...over,
  };
}

afterEach(async () => {
  await disposeDesktopFeatures();
  vi.clearAllMocks();
});

describe("desktopFeatures 静态注册表", () => {
  it("id 唯一，且包含 capture 与 open-source-notices，均仅限 nuwax", () => {
    const ids = desktopFeatures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["capture", "open-source-notices"]));
    for (const f of desktopFeatures) expect(f.products).toEqual(["nuwax"]);
  });
});

describe("startDesktopFeatures", () => {
  const feature = (id: string, over: Partial<DesktopFeature> = {}): DesktopFeature => ({
    id,
    products: ["nuwax"],
    enabledByDefault: true,
    register: vi.fn((_ctx: FeatureContext) => ({ dispose: vi.fn() })),
    ...over,
  });

  it("为每个特性构造上下文：ipc / hostIpc / 以 <dataDir>/<id> 为根的 scratch", () => {
    const f = feature("alpha");
    startDesktopFeatures(options(), [f]);
    const ctx = (f.register as ReturnType<typeof vi.fn>).mock.calls[0][0] as FeatureContext;
    expect(ctx.product).toBe("nuwax");
    expect(typeof ctx.ipc.handle).toBe("function");
    expect(typeof ctx.hostIpc.handle).toBe("function");
    expect(ctx.scratch.root.replace(/\\/g, "/")).toBe("/home/u/.nuwax/alpha");
  });

  it("两条 IPC 使用各自的信任判定", async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, l: (e: unknown, ...a: unknown[]) => unknown) => void handlers.set(c, l)),
      removeHandler: vi.fn(),
    };
    const f = feature("beta", {
      register: (ctx) => {
        ctx.ipc.handle("b:biz", () => "biz-ok", "biz-denied");
        ctx.hostIpc.handle("b:host", () => "host-ok", "host-denied");
        return { dispose: () => undefined };
      },
    });
    startDesktopFeatures(options({ ipcMain: ipcMain as never, isBusinessSender: () => false, isHostSender: () => true }), [f]);
    expect(await handlers.get("b:biz")!({})).toBe("biz-denied");
    expect(await handlers.get("b:host")!({})).toBe("host-ok");
  });

  it("按产品与开关过滤；关闭的特性零接触", () => {
    const wrongProduct = feature("p", { products: ["nuwaclaw"] });
    const off = feature("o", { enabledByDefault: false });
    const on = feature("n");
    const out = startDesktopFeatures(options(), [wrongProduct, off, on]);
    expect(out.ids).toEqual(["n"]);
    expect(wrongProduct.register).not.toHaveBeenCalled();
    expect(off.register).not.toHaveBeenCalled();
  });

  it("重复启动幂等：返回同一个注册结果，不重复注册", () => {
    const f = feature("alpha");
    const a = startDesktopFeatures(options(), [f]);
    const b = startDesktopFeatures(options(), [f]);
    expect(b).toBe(a);
    expect(f.register).toHaveBeenCalledTimes(1);
  });

  it("登出/换域事件到达特性订阅者", () => {
    const seen: string[] = [];
    const f = feature("alpha", {
      register: (ctx) => {
        ctx.lifecycle.onSessionEnd((reason) => seen.push(reason));
        return { dispose: () => undefined };
      },
    });
    startDesktopFeatures(options(), [f]);
    notifyFeatureSessionEnd("logout");
    notifyFeatureSessionEnd("switch-domain");
    expect(seen).toEqual(["logout", "switch-domain"]);
  });

  it("退出：先发 quit，再逆序释放；释放后事件不再送达", async () => {
    const order: string[] = [];
    const mk = (id: string) =>
      feature(id, {
        register: (ctx) => {
          ctx.lifecycle.onQuit(() => void order.push(`quit:${id}`));
          ctx.lifecycle.onSessionEnd(() => void order.push(`end:${id}`));
          return { dispose: () => void order.push(`dispose:${id}`) };
        },
      });
    startDesktopFeatures(options(), [mk("a"), mk("b")]);
    await disposeDesktopFeatures();
    expect(order).toEqual(["quit:a", "quit:b", "dispose:b", "dispose:a"]);
    notifyFeatureSessionEnd("logout");
    expect(order).not.toContain("end:a");
  });

  it("未启动时 notify / dispose 都是安全的空操作", async () => {
    expect(() => notifyFeatureSessionEnd("logout")).not.toThrow();
    await expect(disposeDesktopFeatures()).resolves.toBeUndefined();
  });

  it("宿主菜单只读实际注册结果，关闭、注册失败和退出均无入口", async () => {
    expect(isDesktopFeatureRegistered("capture")).toBe(false);
    startDesktopFeatures(options(), [feature("capture", { enabledByDefault: false })]);
    expect(isDesktopFeatureRegistered("capture")).toBe(false);
    await disposeDesktopFeatures();
    startDesktopFeatures(options(), [feature("capture", { register: () => { throw new Error("failed"); } })]);
    expect(isDesktopFeatureRegistered("capture")).toBe(false);
    await disposeDesktopFeatures();
    startDesktopFeatures(options(), [feature("capture")]);
    expect(isDesktopFeatureRegistered("capture")).toBe(true);
    expect(isDesktopFeatureRegistered("missing")).toBe(false);
    await disposeDesktopFeatures();
    expect(isDesktopFeatureRegistered("capture")).toBe(false);
  });
});
