/** nuwaxBridgeHandlers 的 cookie 会话、升级和业务域切换回归。 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { session } from "electron";

const settings = new Map<string, unknown>();
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
const emitters = new Map<string, ((...args: unknown[]) => void)[]>();
let mainWindowSender: ((channel: string, payload: unknown) => void) | undefined;
const mainFrame = { url: "file:///app/index.html" };
const mainWindowContents = {
  mainFrame,
  getURL: () => mainFrame.url,
  send: (channel: string, payload: unknown) => mainWindowSender?.(channel, payload),
};

// vi.mock 工厂被提升，共享 mock 需经 vi.hoisted 提前创建
const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  netFetch: vi.fn(),
  stop: vi.fn(async () => ({ success: true, results: {} })),
  storage: vi.fn(async () => undefined),
  // captureTicketCookie 的 session.cookies.get（默认查不到 ticket）
  cookiesGet: vi.fn(async () => []),
  cookiesSet: vi.fn(async () => undefined),
  cookiesRemove: vi.fn(async () => undefined),
  cookiesOn: vi.fn(),
  loadURL: vi.fn(),
  windowOptions: vi.fn(),
  destroyWindow: vi.fn(),
  refreshGateway: vi.fn(async () => undefined),
  partitionSessions: new Map<string, {
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    setPermissionCheckHandler: ReturnType<typeof vi.fn>;
  }>(),
  installContextMenu: vi.fn(),
}));

vi.mock("../services/loopbackGateway", () => ({
  refreshLoopbackGateway: mocks.refreshGateway,
}));

vi.mock("../services/sessionAuthInjection", () => ({
  initSessionAuthInjection: vi.fn(),
  trustInitialBusinessNavigation: vi.fn(),
}));

vi.mock("../services/contextMenu", () => ({
  installContextMenuService: mocks.installContextMenu,
}));

vi.mock("electron", () => ({
  // app.on：registerCuaQuitCleanup（will-quit 停 daemon）与 fullDiskAccess
  // boot 钩子（browser-window-created/focus）在注册期挂监听
  app: { isPackaged: false, on: vi.fn(), getAppPath: () => process.cwd() },
  powerMonitor: { on: vi.fn() },
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...a: unknown[]) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
    on: (channel: string, fn: (...a: unknown[]) => void) => {
      const list = emitters.get(channel) ?? [];
      list.push(fn);
      emitters.set(channel, list);
    },
  },
  dialog: { showSaveDialog: mocks.showSaveDialog, showOpenDialog: mocks.showOpenDialog },
  net: { fetch: mocks.netFetch },
  BrowserWindow: class {
    constructor(options: unknown) { mocks.windowOptions(options); }
    webContents = { once: vi.fn() };
    private closed: (() => void) | null = null;
    private destroyed = false;
    on = vi.fn((name: string, callback: () => void) => {
      if (name === "closed") this.closed = callback;
    });
    focus = vi.fn();
    loadURL = mocks.loadURL;
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
      mocks.destroyWindow();
      this.closed?.();
    };
  },
  webContents: {
    // isDestroyed/getType：注册期 webview 导航真值通道会遍历现有 webContents
    // （nuwax:webview-nav-*，bug 2432）；browser 类型使其跳过 guest 事件挂载。
    getAllWebContents: () => [
      {
        session: { clearStorageData: mocks.storage },
        isDestroyed: () => false,
        getType: () => "browser",
        on: vi.fn(),
      },
    ],
  },
  session: {
    defaultSession: { cookies: { get: mocks.cookiesGet, set: mocks.cookiesSet,
      remove: mocks.cookiesRemove, on: mocks.cookiesOn } },
    fromPartition: (partition: string) => {
      const ses = {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setSpellCheckerEnabled: vi.fn(),
      };
      mocks.partitionSessions.set(partition, ses);
      return ses;
    },
  },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../db", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
  writeSetting: (key: string, value: unknown) => {
    settings.set(key, value);
  },
  // clearShellAuthState 的 savedKey 前缀批删走 getDb()；测试环境用内存 Map 模拟
  getDb: () => ({
    prepare: (sql: string) => ({
      run: () => {
        if (sql.includes("auth.saved_keys.%")) {
          let changes = 0;
          for (const key of [...settings.keys()]) {
            if (key.startsWith("auth.saved_keys.")) {
              settings.delete(key);
              changes++;
            }
          }
          return { changes };
        }
        return { changes: 0 };
      },
    }),
  }),
}));

vi.mock("./processHandlers", () => ({
  stopAllServicesNow: mocks.stop,
  restartAllServicesNow: vi.fn(async () => ({ success: true })),
}));

import {
  registerNuwaxBridgeHandlers,
  NUWAX_TOKEN_KEY_PREFIX,
} from "./nuwaxBridgeHandlers";
import { DEFAULT_SERVER_HOST } from "../../shared/constants";
import { getMainLang, setMainLang } from "../services/i18n";

const GW_ORIGIN = "http://127.0.0.1:46800";
const HOST_ORIGIN = "https://testagent.xspaceagi.com";
const DEV_ORIGIN = "http://localhost:3000";

function senderEvent(origin: string) {
  return {
    senderFrame: { url: `${origin}/home` },
    sender: { getURL: () => `${origin}/home` },
  };
}

function hostEvent() {
  return { senderFrame: mainFrame, sender: mainWindowContents };
}

beforeEach(() => {
  mocks.stop.mockResolvedValue({ success: true, results: {} });
  mocks.storage.mockClear();
  mocks.cookiesGet.mockReset().mockResolvedValue([]);
  mocks.cookiesSet.mockReset().mockResolvedValue(undefined);
  mocks.cookiesRemove.mockReset().mockResolvedValue(undefined);
  mocks.cookiesOn.mockClear();
  mocks.loadURL.mockClear();
  mocks.showSaveDialog.mockClear();
  mocks.showOpenDialog.mockClear();
  mocks.windowOptions.mockClear();
  mocks.destroyWindow.mockClear();
  mocks.partitionSessions.clear();
  mocks.refreshGateway.mockReset().mockResolvedValue(undefined);
  mocks.installContextMenu.mockClear();
  settings.clear();
  settings.set("nuwax.cookieAuthMigrated", true);
  handlers.clear();
  emitters.clear();
  mainWindowSender = undefined;
  registerNuwaxBridgeHandlers({
    getMainWindow: () =>
      ({
        webContents: mainWindowContents,
      }) as never,
  } as never);
  settings.set("step1_config", { serverHost: HOST_ORIGIN });
  settings.set("nuwax.loopback", { enabled: true, origin: GW_ORIGIN });
  handlers.get("auth:getContext")!(senderEvent(GW_ORIGIN));
});

describe("cookie 会话与旧 token 桥", () => {
  it("开发覆盖地址带路径时，桥信任仍按 origin 判断", () => {
    settings.set("nuwax.webviewOverride", { origin: `${DEV_ORIGIN}/app/` });
    expect(handlers.get("auth:getContext")!(senderEvent(DEV_ORIGIN)))
      .toMatchObject({ businessOrigin: HOST_ORIGIN });
  });

  it("带 userinfo 的 URL 不能借相同 origin 调用业务桥", () => {
    expect(handlers.get("auth:getContext")!(
      senderEvent("https://user:pass@testagent.xspaceagi.com"),
    )).toBeNull();
  });
  it("direct WebView cookie 同步到主进程并触发首次设备注册", async () => {
    settings.set("nuwax.loopback", { enabled: false, origin: null });
    mocks.cookiesGet.mockResolvedValue([{ name: "ticket", value: "direct-new", path: "/", secure: true,
      domain: new URL(HOST_ORIGIN).hostname }] as never);
    const user = () => new Response(JSON.stringify({ code: "0000", data: { userName: "alice" } }));
    mocks.netFetch.mockReset().mockResolvedValueOnce(user()).mockResolvedValueOnce(user())
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "0000", data: {
        configKey: "device-key", serverHost: "tunnel.example", serverPort: 443,
      } })));
    expect(await handlers.get("auth:syncSession")!(senderEvent(HOST_ORIGIN))).toBe(true);
    expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBe("direct-new");
    await vi.waitFor(() => expect(settings.get("auth.config_key")).toBe("device-key"));
    expect(mocks.netFetch.mock.calls[0][1].headers.Cookie).toBe("ticket=direct-new");
    mocks.cookiesGet.mockResolvedValue([{ name: "ticket", value: "direct-rotated", path: "/", secure: true,
      domain: new URL(HOST_ORIGIN).hostname }] as never);
    const changed = mocks.cookiesOn.mock.calls.find(([event]) => event === "changed")?.[1];
    changed?.({}, { name: "ticket", domain: new URL(HOST_ORIGIN).hostname, value: "direct-rotated" }, "explicit", false);
    await vi.waitFor(() => expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBe("direct-rotated"));
  });

  it("旧桥不再返回或持久化 token", async () => {
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`, "LEGACY");
    expect(await handlers.get("auth:getToken")!(senderEvent(GW_ORIGIN))).toBeNull();
    expect(await handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), "LEGACY")).toBe(false);
  });

  it("开始新登录前清除业务域和网关旧 cookie", async () => {
    settings.set(`nuwax.ticket.${HOST_ORIGIN}`, "old");
    await handlers.get("auth:beginLogin")!(senderEvent(GW_ORIGIN));
    expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBeNull();
    expect(mocks.cookiesRemove).toHaveBeenCalledWith(HOST_ORIGIN, "ticket");
    expect(mocks.cookiesRemove).toHaveBeenCalledWith(GW_ORIGIN, "ticket");
  });

  it("登出清业务域和网关 ticket，并保留同账号设备注册键", async () => {
    const sent: string[] = [];
    mainWindowSender = (channel) => sent.push(channel);
    settings.set(`nuwax.ticket.${HOST_ORIGIN}`, "old");
    settings.set(`nuwax.ticket.${GW_ORIGIN}`, "old");
    settings.set("auth.saved_key", "sk");
    settings.set("auth.username", "alice");
    await handlers.get("auth:clear")!(senderEvent(GW_ORIGIN));
    expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBeNull();
    expect(settings.get(`nuwax.ticket.${GW_ORIGIN}`)).toBeNull();
    expect(settings.get("auth.saved_key")).toBe("sk");
    expect(settings.get("auth.username")).toBe("alice");
    expect(sent).not.toContain("nuwax:serverHostChanged");
    expect(mocks.storage).toHaveBeenCalledWith(expect.objectContaining({ storages: ["cookies"] }));
  });

  it("升级后无 ticket 的 401 不反复清除 webview 存储", async () => {
    await handlers.get("auth:clear")!(senderEvent(GW_ORIGIN));
    expect(mocks.storage).not.toHaveBeenCalled();
    handlers.get("auth:getContext")!(senderEvent(GW_ORIGIN));
    await handlers.get("auth:clear")!(senderEvent(GW_ORIGIN));
    expect(mocks.storage).not.toHaveBeenCalled();
  });
});

describe("configureServerHost（企业登录切换域名）", () => {
  it("拒绝宿主在前一次切域未完成时再次切域", async () => {
    let finishStop!: (value: { success: boolean; results: Record<string, never> }) => void;
    mocks.stop.mockImplementationOnce(() => new Promise((resolve) => { finishStop = resolve; }));
    const priorStops = mocks.stop.mock.calls.length;
    const first = handlers.get("auth:configureServerHost")!(senderEvent(GW_ORIGIN), "first.example.com");
    const second = await handlers.get("services:configureServerHost")!(hostEvent(), "second.example.com") as {
      success: boolean; error?: string;
    };
    expect(second).toEqual({ success: false, error: "Domain switch already in progress" });
    expect(mocks.stop).toHaveBeenCalledTimes(priorStops + 1);
    finishStop({ success: true, results: {} });
    expect((await first as { success: boolean }).success).toBe(true);
    expect((settings.get("step1_config") as { serverHost: string }).serverHost)
      .toBe("https://first.example.com");
  });
  it("closes existing business secondary windows before changing the trusted origin", async () => {
    expect(handlers.get("native:openWindow")!(senderEvent(GW_ORIGIN), {
      path: `${HOST_ORIGIN}/agent/detail`,
    })).toEqual({ success: true });
    expect(mocks.destroyWindow).not.toHaveBeenCalled();

    const result = await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN), "biz.example.com",
    ) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mocks.destroyWindow).toHaveBeenCalledTimes(1);
  });

  it("合法域名 → 写 step1_config.serverHost（保留其余字段）并广播重载事件", async () => {
    const sent: [string, unknown][] = [];
    mainWindowSender = (c, p) => sent.push([c, p]);

    const res = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN),
      "biz.example.com",
    )) as { success: boolean; serverHost?: string };

    expect(res.success).toBe(true);
    expect(res.serverHost).toBe("https://biz.example.com");
    const step1 = settings.get("step1_config") as Record<string, unknown>;
    expect(step1.serverHost).toBe("https://biz.example.com");
    expect(sent.some(([c]) => c === "nuwax:serverHostChanged")).toBe(true);
  });

  it("非法输入 → 失败返回且不写配置", async () => {
    const before = settings.get("step1_config");
    const empty = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN),
      "   ",
    )) as { success: boolean };
    const bad = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN),
      "ht tp://bad domain",
    )) as { success: boolean };
    expect(empty.success).toBe(false);
    expect(bad.success).toBe(false);
    expect(settings.get("step1_config")).toEqual(before);
  });

  it("切换域名 → 清旧域派生凭据与旧域 token 键（否则 Start All / lanproxy 用旧域 key）", async () => {
    // 旧域登录态残留：savedKey/configKey（lanproxy clientKey 来源）+ 旧域 token 键
    settings.set("auth.saved_key", "OLD-SK");
    settings.set("auth.config_key", "OLD-CK");
    settings.set("auth.username", "user1");
    settings.set(
      `auth.saved_keys.${new URL(HOST_ORIGIN).hostname}_user1`,
      "OLD-SK1",
    );
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`, "OLD-TOKEN-GW");
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`, "OLD-TOKEN-HOST");
    // 旧域隧道地址（serviceManager 起 lanproxy 时读）
    settings.set("lanproxy.server_host", new URL(HOST_ORIGIN).host);
    settings.set("lanproxy.server_port", 8080);

    const res = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN),
      "biz.example.com",
    )) as { success: boolean };

    expect(res.success).toBe(true);
    // 派生凭据清空
    expect(settings.get("auth.saved_key")).toBeNull();
    expect(settings.get("auth.config_key")).toBeNull();
    expect(settings.get("auth.username")).toBeNull();
    expect(
      settings.get(`auth.saved_keys.${new URL(HOST_ORIGIN).hostname}_user1`),
    ).toBeUndefined();
    // 旧域 token 键（含网关键）清空，避免换域后仍被代注/回退链读到
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`)).toBeNull();
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`)).toBeNull();
    // 旧域隧道地址清空，由新域登录的 reg 回写
    expect(settings.get("lanproxy.server_host")).toBeNull();
    expect(settings.get("lanproxy.server_port")).toBeNull();
    // 业务域本身照旧写入新域
    const step1 = settings.get("step1_config") as Record<string, unknown>;
    expect(step1.serverHost).toBe("https://biz.example.com");
  });

  it("新域网关刷新失败时恢复旧配置和旧网关，登录态仍清除", async () => {
    settings.set("auth.saved_key", "OLD-SK");
    mocks.refreshGateway.mockRejectedValueOnce(new Error("new gateway failed"));
    const result = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN), "other.example.com",
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("previous gateway restored");
    expect(mocks.refreshGateway).toHaveBeenCalledTimes(2);
    expect((settings.get("step1_config") as { serverHost: string }).serverHost).toBe(HOST_ORIGIN);
    expect(settings.get("auth.saved_key")).toBeNull();
  });
});

describe("native:saveImage（另存图片）", () => {
  const tmpFile = path.join(os.tmpdir(), `nuwax-saveimage-${process.pid}.png`);

  beforeEach(() => {
    mocks.showSaveDialog.mockReset();
    mocks.netFetch.mockReset();
    vi.stubGlobal("fetch", mocks.netFetch);
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: tmpFile,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpFile, { force: true });
  });

  it("相对地址 → 按调用方 frame origin 归一为绝对地址再取图并流式落盘", async () => {
    mocks.netFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );

    const res = (await handlers.get("native:saveImage")!(
      senderEvent(GW_ORIGIN),
      { url: "/api/computer/static/photo.png" },
    )) as { success: boolean; path?: string };

    expect(res.success).toBe(true);
    expect(mocks.netFetch).toHaveBeenCalledWith(
      `${HOST_ORIGIN}/api/computer/static/photo.png`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(fs.readFileSync(tmpFile)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("绝对地址 → 原样取图", async () => {
    mocks.netFetch.mockResolvedValue(
      new Response(new Uint8Array([9]), { status: 200 }),
    );

    const res = (await handlers.get("native:saveImage")!(
      senderEvent(GW_ORIGIN),
      { url: `${HOST_ORIGIN}/a/b.png` },
    )) as { success: boolean };

    expect(res.success).toBe(true);
    expect(mocks.netFetch).toHaveBeenCalledWith(
      `${HOST_ORIGIN}/a/b.png`,
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("非 http(s) 协议 → 拒绝且不发起取图", async () => {
    const res = (await handlers.get("native:saveImage")!(
      senderEvent(GW_ORIGIN),
      { url: "file:///etc/passwd" },
    )) as { success: boolean; error?: string };

    expect(res.success).toBe(false);
    expect(res.error).toBe("unsupported protocol");
    expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  it("相对地址但 frame 无 origin → 判非法（不猜基准地址）", async () => {
    const res = (await handlers.get("native:saveImage")!(
      { senderFrame: { url: "" } },
      { url: "/x.png" },
    )) as { success: boolean; error?: string };

    expect(res.success).toBe(false);
    expect(res.error).toBe("untrusted sender");
    expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  it("取消保存对话框 → 返回 canceled 且不取图", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });

    const res = (await handlers.get("native:saveImage")!(
      senderEvent(GW_ORIGIN),
      { url: `${HOST_ORIGIN}/a/b.png` },
    )) as { success: boolean; canceled?: boolean };

    expect(res.canceled).toBe(true);
    expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  it("外链窗口右键保存业务域图片不代注 ticket，站内右键仍可代注", async () => {
    settings.set(`nuwax.ticket.${HOST_ORIGIN}`, "private-ticket");
    mocks.netFetch.mockImplementation(async () =>
      new Response(new Uint8Array([1]), { status: 200 }),
    );
    const saveFromMenu = (mocks.installContextMenu.mock.lastCall?.[0] as {
      saveImage: (
        opts: { url: string },
        frameUrl: string,
        source: { isDestroyed: () => boolean; getURL: () => string; session: unknown },
      ) => Promise<{ success: boolean }>;
    }).saveImage;
    const source = (origin: string, isolated = false) => ({
      isDestroyed: () => false,
      getURL: () => `${origin}/home`,
      session: isolated ? {} : session.defaultSession,
    });

    const external = await saveFromMenu(
      { url: `${HOST_ORIGIN}/private.png` },
      "https://external.example/page",
      source("https://external.example"),
    );
    expect(external.success).toBe(true);
    expect(mocks.netFetch.mock.calls[0][1].headers).toEqual({});

    const externalFrame = await saveFromMenu(
      { url: `${HOST_ORIGIN}/private.png` },
      "https://external.example/embedded",
      source(GW_ORIGIN),
    );
    expect(externalFrame.success).toBe(true);
    expect(mocks.netFetch.mock.calls[1][1].headers).toEqual({});

    const loopback = await saveFromMenu(
      { url: `${GW_ORIGIN}/private.png` },
      "https://external.example/page",
      source("https://external.example"),
    );
    expect(loopback).toEqual({ success: false, error: "untrusted source" });
    expect(mocks.netFetch).toHaveBeenCalledTimes(2);

    const internal = await saveFromMenu(
      { url: `${HOST_ORIGIN}/private.png` },
      `${GW_ORIGIN}/home`,
      source(GW_ORIGIN),
    );
    expect(internal.success).toBe(true);
    expect(mocks.netFetch.mock.calls[2][1].headers).toEqual({
      Cookie: "ticket=private-ticket",
    });

    const isolatedOnBusinessOrigin = await saveFromMenu(
      { url: `${HOST_ORIGIN}/private.png` },
      `${GW_ORIGIN}/home`,
      source(GW_ORIGIN, true),
    );
    expect(isolatedOnBusinessOrigin.success).toBe(true);
    expect(mocks.netFetch.mock.calls[3][1].headers).toEqual({});
  });
});

describe("语言同步（webview 多语言 → 壳）", () => {
  it("nuwax:lang-sync → 转发 nuwax:lang-changed 给壳 renderer", () => {
    const sent: [string, unknown][] = [];
    mainWindowSender = (c, p) => sent.push([c, p]);

    const emit = emitters.get("nuwax:lang-sync")?.[0];
    expect(emit).toBeDefined();
    emit!(senderEvent(GW_ORIGIN), { lang: "en-US" });

    const changed = sent.find(([c]) => c === "nuwax:lang-changed");
    expect(changed).toBeDefined();
    expect(changed![1]).toEqual({ lang: "en-us" });
  });

  it("非法/空语言 → 不转发", () => {
    const sent: [string, unknown][] = [];
    mainWindowSender = (c, p) => sent.push([c, p]);

    const emit = emitters.get("nuwax:lang-sync")?.[0];
    emit!(senderEvent(GW_ORIGIN), { lang: "   " });
    emit!(senderEvent(GW_ORIGIN), { lang: 123 });
    emit!(senderEvent(GW_ORIGIN), null);

    expect(sent.some(([c]) => c === "nuwax:lang-changed")).toBe(false);
  });
});

describe("trusted runtime auth context and window navigation", () => {
  const windowEvent = (frameOrigin = GW_ORIGIN, topOrigin = GW_ORIGIN) => ({
    senderFrame: { url: `${frameOrigin}/home` },
    sender: { getURL: () => `${topOrigin}/home` },
  });

  it("returns the runtime business/gateway origins only to admitted pages", () => {
    expect(handlers.get("auth:getContext")!(senderEvent(GW_ORIGIN))).toEqual({
      businessOrigin: HOST_ORIGIN, gatewayOrigin: GW_ORIGIN, loadMode: "gateway",
    });
    expect(handlers.get("auth:getContext")!(senderEvent("https://external.example"))).toBeNull();
    settings.set("nuwax.loopback", { enabled: false, origin: null });
    expect(handlers.get("auth:getContext")!(senderEvent(HOST_ORIGIN))).toEqual({
      businessOrigin: HOST_ORIGIN, gatewayOrigin: null, loadMode: "direct",
    });
  });

  it("keeps business SPA paths while rewriting standalone windows through the gateway", () => {
    handlers.get("native:openWindow")!(windowEvent(), { path: `${HOST_ORIGIN}/agent/detail?id=1#section` });
    expect(mocks.loadURL).toHaveBeenCalledWith(`${GW_ORIGIN}/agent/detail?id=1&_shell=1#section`);
  });

  it("marks an absolute same-origin popup as a standalone window in direct mode", () => {
    settings.set("nuwax.loopback", { enabled: false, origin: null });
    expect(handlers.get("native:openWindow")!(windowEvent(HOST_ORIGIN, HOST_ORIGIN), {
      path: `${HOST_ORIGIN}/agent/detail?id=1`,
    })).toEqual({ success: true });
    expect(mocks.loadURL).toHaveBeenCalledWith(`${HOST_ORIGIN}/agent/detail?id=1&_shell=1`);
  });

  it("keeps a double-slash business pathname under the gateway authority", () => {
    handlers.get("native:openWindow")!(windowEvent(), { path: `${HOST_ORIGIN}//external.example/path?q=1#section` });
    expect(mocks.loadURL).toHaveBeenCalledWith(`${GW_ORIGIN}//external.example/path?q=1&_shell=1#section`);
    expect(new URL(mocks.loadURL.mock.calls[0][0]).origin).toBe(GW_ORIGIN);
  });

  it.each(["https://external.example/path", "http://testagent.xspaceagi.com/path", "https://username:password@testagent.xspaceagi.com/path"])("does not rewrite non-business or credentialed URLs: %s", (url) => {
    handlers.get("native:openWindow")!(windowEvent(), { path: url });
    expect(mocks.loadURL).toHaveBeenCalledWith(url);
    const preferences = (mocks.windowOptions.mock.lastCall?.[0] as { webPreferences: Record<string, unknown> }).webPreferences;
    expect(preferences.preload).toBeUndefined();
    expect(preferences.partition).toMatch(/^temp:nuwax-external-/);
    const isolated = mocks.partitionSessions.get(preferences.partition as string);
    expect(isolated?.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(isolated?.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    const check = isolated?.setPermissionCheckHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string,
    ) => boolean;
    expect(check(null, "media")).toBe(false);
  });

  it.each([
    ["https://external.example", "https://external.example"],
    ["https://external.example", GW_ORIGIN],
    [GW_ORIGIN, "https://external.example"],
  ])("rejects external callers or frames before granting an authenticated new window: %s %s", (frameOrigin, topOrigin) => {
    expect(handlers.get("native:openWindow")!(windowEvent(frameOrigin, topOrigin), { path: `${HOST_ORIGIN}/api/protected` }))
      .toEqual({ success: false, error: "untrusted sender" });
    expect(mocks.loadURL).not.toHaveBeenCalled();
  });

  it("跨域导航后旧 preload 无法触发目录选择、另存、设置或更新主进程状态", async () => {
    const navigated = windowEvent(GW_ORIGIN, "https://external.example");
    expect(handlers.get("auth:getContext")!(navigated)).toBeNull();
    expect(await handlers.get("localFiles:pickDirectory")!(navigated))
      .toEqual({ canceled: true, paths: [] });
    expect(await handlers.get("native:saveImage")!(navigated, { url: `${HOST_ORIGIN}/a.png` }))
      .toEqual({ success: false, error: "untrusted sender" });
    expect(handlers.get("native:openClientSettings")!(navigated))
      .toEqual({ success: false, error: "untrusted sender" });
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });
});


describe("webview is the shell language source", () => {
  it("trusted language sync persists raw language, updates main and never reloads guest", () => {
    setMainLang("zh-cn");
    const handler = emitters.get("nuwax:lang-sync")![0];
    handler(senderEvent(HOST_ORIGIN), { lang: "en-US" });
    expect(settings.get("nuwax.webview_lang")).toBe("en-us");
    expect(getMainLang()).toBe("en-us");
    expect(mocks.loadURL).not.toHaveBeenCalled();
  });
  it("unsupported guest language falls back only in shell", () => {
    emitters.get("nuwax:lang-sync")![0](senderEvent(HOST_ORIGIN), { lang: "ja-JP" });
    expect(settings.get("nuwax.webview_lang")).toBe("ja-jp");
    expect(getMainLang()).toBe("zh-cn");
    expect(mocks.loadURL).not.toHaveBeenCalled();
  });
  it("untrusted or malformed language cannot overwrite mirror", () => {
    const handler = emitters.get("nuwax:lang-sync")![0];
    handler(senderEvent("https://untrusted.example"), { lang: "en-US" });
    handler(senderEvent(HOST_ORIGIN), { lang: "../../en-US" });
    expect(settings.has("nuwax.webview_lang")).toBe(false);
  });
});
