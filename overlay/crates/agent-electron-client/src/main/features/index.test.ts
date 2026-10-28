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
  emitFeatureSessionInvalidated,
  runFeatureServicesStarting,
  runFeatureServicesStopping,
  settleDesktopFeaturesForQuit,
  createDesktopAgentSessions,
  registerDesktopAgentSessionParticipant,
  desktopFeatureActivities,
  onDesktopFeatureActivitiesChanged,
  runDesktopActivity,
  isFeatureCapabilityAvailable,
  type StartFeaturesOptions,
} from "./index";
import type { DesktopFeature, FeatureContext } from "./_kit/types";
import { createLocalFilesBridge } from "../../preload/features/local-files";

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
    expect(ids).toEqual(expect.arrayContaining(["computer-use", "capture", "open-source-notices", "local-files"]));
    for (const f of desktopFeatures) expect(f.products).toEqual(["nuwax"]);
  });
});

const feature = (id: string, over: Partial<DesktopFeature> = {}): DesktopFeature => ({
  id,
  products: ["nuwax"],
  enabledByDefault: true,
  register: vi.fn((_ctx: FeatureContext) => ({ dispose: vi.fn() })),
  ...over,
});

describe("startDesktopFeatures", () => {
  it("为每个特性构造上下文：ipc / hostIpc / 以 <dataDir>/<id> 为根的 scratch", () => {
    const f = feature("alpha");
    startDesktopFeatures(options(), [f]);
    const ctx = (f.register as ReturnType<typeof vi.fn>).mock.calls[0][0] as FeatureContext;
    expect(ctx.product).toBe("nuwax");
    expect(typeof ctx.ipc.handle).toBe("function");
    expect(typeof ctx.hostIpc.handle).toBe("function");
    expect(ctx.scratch.root.replace(/\\/g, "/")).toBe("/home/u/.nuwax/alpha");
    expect(ctx.dataDir.replace(/\\/g, "/")).toBe("/home/u/.nuwax/alpha");
    expect(typeof ctx.settings.read).toBe("function");
    expect(typeof ctx.agent.setLocalMcpServer).toBe("function");
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

  it("进行中操作登记到活动板：按特性顺序展示、动作可执行、清除与退出失效", async () => {
    let context!: FeatureContext;
    const stop = vi.fn(), pause = vi.fn();
    const seen: number[] = [];
    startDesktopFeatures(options(), [feature("computer-use", {
      register(ctx) {
        ctx.activities.set({ actions: [{ id: "stop", labelKey: "Claw.Cua.stop", run: stop }] });
        return { dispose() {} };
      },
    }), feature("capture", {
      register(ctx) {
        context = ctx;
        return { dispose() {} };
      },
    })]);
    const off = onDesktopFeatureActivitiesChanged((entries) => seen.push(entries.length));
    context.activities.set({ actions: [
      { id: "pause", labelKey: "Claw.Capture.pause", run: pause },
      { id: "stop", labelKey: "Claw.Capture.stopRecording", run: stop },
    ] });
    // 展示顺序 = 注册表顺序（computer-use 先于 capture）
    expect(desktopFeatureActivities().map((entry) => entry.featureId)).toEqual(["computer-use", "capture"]);
    expect(seen).toEqual([2]);
    expect(runDesktopActivity("capture", "pause")).toBe(true);
    expect(pause).toHaveBeenCalledOnce();
    expect(runDesktopActivity("capture", "missing")).toBe(false);
    expect(runDesktopActivity("missing", "stop")).toBe(false);
    context.activities.set(null);
    expect(desktopFeatureActivities().map((entry) => entry.featureId)).toEqual(["computer-use"]);
    expect(runDesktopActivity("capture", "stop")).toBe(false);
    expect(runDesktopActivity("computer-use", "stop")).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    off();
    await disposeDesktopFeatures();
    expect(desktopFeatureActivities()).toEqual([]);
    expect(runDesktopActivity("computer-use", "stop")).toBe(false);
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

  it.each([
    [undefined, true],
    [true, true],
    [false, false],
  ])("本机文件直访默认开启，设置覆盖 %s 时注册结果为 %s", async (override, expected) => {
    const localFiles = desktopFeatures.find((f) => f.id === "local-files")!;
    const register = vi.spyOn(localFiles, "register").mockReturnValue({ dispose: vi.fn() });
    const readEnabled = vi.fn((id: string, def: boolean) => (id === "local-files" ? override ?? def : def));
    const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
    try {
      const out = startDesktopFeatures(options({ ipcMain, isEnabled: readEnabled }), [localFiles]);
      expect(readEnabled).toHaveBeenCalledWith("local-files", true);
      expect(out.ids).toEqual(expected ? ["local-files"] : []);
      expect(isDesktopFeatureRegistered("local-files")).toBe(expected);
      expect(register).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (!expected) {
        expect(ipcMain.handle.mock.calls.map((call) => call[0])).toEqual(["features:registered"]);
        const bridge = createLocalFilesBridge({ invoke: vi.fn().mockRejectedValue(new Error("No handler registered")) });
        expect(await bridge.getCapabilities()).toEqual({ apiVersion: 3, available: false });
      }
    } finally {
      register.mockRestore();
    }
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

describe("生命周期 v2 与 Agent 会话", () => {
  it("会话失效即同步撤销；服务启动顺序等待并先清理未启用特性残留 MCP 条目", async () => {
    const order: string[] = [];
    const removed: string[] = [];
    const f = feature("alpha", {
      agentServers: ["cua"],
      register: (ctx) => {
        ctx.lifecycle.onSessionInvalidated(() => order.push("invalidated"));
        ctx.lifecycle.onServicesStarting(async () => { order.push("starting"); });
        return { dispose: () => undefined };
      },
    });
    const inactive = feature("beta", { agentServers: ["ghost"], enabledByDefault: false });
    const has = vi.fn((id: string) => id === "cua" || id === "ghost");
    const remove = vi.fn(async (id: string) => { removed.push(id); });
    startDesktopFeatures(options({ host: {
      settings: { read: () => null, write: () => true },
      session: { isAuthenticated: () => true },
      windows: { getMain: () => null },
      agent: { setLocalMcpServer: remove as never, hasLocalMcpServer: has as never, resolveNodeBinary: () => null },
    } }), [f, inactive]);
    emitFeatureSessionInvalidated();
    expect(order).toEqual(["invalidated"]);
    await runFeatureServicesStarting(new AbortController().signal);
    expect(order).toEqual(["invalidated", "starting"]);
    // 未注册特性（beta）保留的 ghost 条目被清理；已注册的 cua 由特性自行管理
    expect(removed).toEqual(["ghost"]);
  });

  it("服务停止并行等待，任一失败视为失败；收尾 Promise 幂等可重复等待", async () => {
    const ok = feature("ok", {
      register: (ctx) => {
        ctx.lifecycle.onServicesStopping(async () => undefined);
        return { dispose: () => undefined };
      },
    });
    const bad = feature("bad", {
      register: (ctx) => {
        ctx.lifecycle.onServicesStopping(async () => { throw new Error("cleanup failed"); });
        return { dispose: () => undefined };
      },
    });
    startDesktopFeatures(options(), [ok, bad]);
    expect((await runFeatureServicesStopping()).success).toBe(false);
    await disposeDesktopFeatures();
    const settled = settleDesktopFeaturesForQuit();
    await expect(settled).resolves.toBeUndefined();
    await expect(settleDesktopFeaturesForQuit()).resolves.toBeUndefined();
  });

  it("Agent 会话参与者：惰性解析、setup 派发、start/finish 按轮次、剥离未启用条目", async () => {
    const calls: string[] = [];
    const participant = () => ({
      prepare(servers: Array<{ name: string }>) {
        calls.push("prepare");
        const index = servers.findIndex((server) => server.name === "stale");
        if (index >= 0) servers.splice(index, 1);
        return {
          bind: (id: string) => calls.push(`bind:${id}`),
          cancel: () => calls.push("cancel"),
        };
      },
      start: (id: string) => { calls.push(`start:${id}`); return 1; },
      finish: (id: string, turn: number, cancelled: boolean) => calls.push(`finish:${id}:${turn}:${cancelled}`),
      cancel: (id: string) => calls.push(`cancel:${id}`),
      remove: (id: string) => calls.push(`remove:${id}`),
      destroy: () => calls.push("destroy"),
    });
    startDesktopFeatures(options(), [feature("alpha", {
      agentServers: ["kept"],
      register: (ctx) => {
        ctx.agent.registerSessionParticipant(participant);
        return { dispose: () => undefined };
      },
    }), feature("ghost-owner", {
      agentServers: ["ghost"],
      enabledByDefault: false,
    })]);
    // 引擎可能先于注册构造：注册表未含参与者时也能工作，注册后按当前工厂解析
    const sessions = createDesktopAgentSessions();
    const servers = [{ name: "kept" }, { name: "stale" }];
    const result = await sessions.setup(servers, async () => ({ id: "s1" }), (r) => r.id);
    expect(result).toEqual({ id: "s1" });
    expect(servers).toEqual([{ name: "kept" }]);
    expect(calls).toEqual(["prepare", "bind:s1"]);
    const turn = sessions.start("s1");
    expect(turn.active).toBe(true);
    sessions.finish("s1", turn, true);
    sessions.cancel("s1"); sessions.remove("s1"); sessions.destroy();
    expect(calls.slice(2)).toEqual(["start:s1", "finish:s1:1:true", "cancel:s1", "remove:s1", "destroy"]);
    // 未启用特性的 agentServers 条目在 setup 时被剥离；已注册特性的条目保留
    calls.length = 0;
    const servers2 = [{ name: "kept" }, { name: "ghost" }];
    await sessions.setup(servers2, async () => 0, () => "x");
    expect(servers2).toEqual([{ name: "kept" }]);
  });

  it("canUse 归属判定：未注册/关开关为 false，清单 canUse 叠加，非特性命名空间为 undefined", async () => {
    const f = feature("alpha", {
      bridge: { namespaces: ["alpha"], canUse: (name) => name !== "alpha.blocked" },
      register: (ctx) => ({ dispose: () => undefined }),
    });
    expect(isFeatureCapabilityAvailable("alpha", "alpha.any")).toBeUndefined();
    startDesktopFeatures(options(), [f, feature("cap-owner", {
      bridge: { namespaces: ["cap"] },
      enabledByDefault: false,
    })]);
    expect(isFeatureCapabilityAvailable("theme", "theme.syncTheme")).toBeUndefined();
    expect(isFeatureCapabilityAvailable("alpha", "alpha.any")).toBe(true);
    expect(isFeatureCapabilityAvailable("alpha", "alpha.blocked")).toBe(false);
    expect(isFeatureCapabilityAvailable("beta", "beta.any")).toBeUndefined();
    expect(isFeatureCapabilityAvailable("cap", "cap.any")).toBe(false);
    await disposeDesktopFeatures();
    // 退出后注册结果清空：真实注册表中的特性归属同样为 false
    expect(isFeatureCapabilityAvailable("alpha", "alpha.any")).toBeUndefined();
    expect(isFeatureCapabilityAvailable("localFiles", "localFiles.any")).toBe(false);
  });
});
