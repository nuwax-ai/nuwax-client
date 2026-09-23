/**
 * 单元测试: nuwaxBridgeHandlers 的 token 键空间统一（nuwaxTokenScopes 三路共用）
 *
 * 回归背景（审查实证的键空间分裂 bug）：
 * - persistToken 单写 sender 键，网关 Bearer 代注源读 serverHost 键 → 网关形态
 *   新登录代注拿空/陈旧 token；
 * - clear 单清 sender 键，getToken 回退链又从 serverHost 键复活过期 token →
 *   401 → clear → 复活死循环。
 * 修复后三路（getToken 回退 / persistToken 双写 / clear 全清）共享 nuwaxTokenScopes。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const settings = new Map<string, unknown>();
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
const emitters = new Map<string, ((...args: unknown[]) => void)[]>();
let mainWindowSender: ((channel: string, payload: unknown) => void) | undefined;

// vi.mock 工厂被提升，共享 mock 需经 vi.hoisted 提前创建
const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  netFetch: vi.fn(),
  stop: vi.fn(async () => ({ success: true, results: {} })),
  storage: vi.fn(async () => undefined),
  // captureTicketCookie 的 session.cookies.get（默认查不到 ticket）
  cookiesGet: vi.fn(async () => []),
  loadURL: vi.fn(),
}));

vi.mock("../services/sessionAuthInjection", () => ({
  initSessionAuthInjection: vi.fn(),
  trustInitialBusinessNavigation: vi.fn(),
}));

vi.mock("electron", () => ({
  // app.on：registerCuaQuitCleanup（will-quit 停 daemon）与 fullDiskAccess
  // boot 钩子（browser-window-created/focus）在注册期挂监听
  app: { isPackaged: false, on: vi.fn() },
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
  dialog: { showSaveDialog: mocks.showSaveDialog },
  BrowserWindow: class {
    webContents = { once: vi.fn() };
    on = vi.fn();
    focus = vi.fn();
    loadURL = mocks.loadURL;
  },
  webContents: {
    // isDestroyed/getType：注册期 webview 导航真值通道会遍历现有 webContents
    // （nuwax:webview-nav-*，bug 2432）；browser 类型使其跳过 guest 事件挂载。
    getAllWebContents: () => [
      {
        session: { clearStorageData: mocks.storage },
        isDestroyed: () => false,
        getType: () => "browser",
      },
    ],
  },
  session: { defaultSession: { cookies: { get: mocks.cookiesGet } } },
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

const GW_ORIGIN = "http://127.0.0.1:46800";
const HOST_ORIGIN = "https://testagent.xspaceagi.com";
const DEV_ORIGIN = "http://localhost:3000";

function senderEvent(origin: string): { senderFrame: { url: string } } {
  return { senderFrame: { url: `${origin}/home` } };
}

beforeEach(() => {
  mocks.stop.mockResolvedValue({ success: true, results: {} });
  mocks.storage.mockClear();
  mocks.cookiesGet.mockReset().mockResolvedValue([]);
  mocks.loadURL.mockClear();
  settings.clear();
  handlers.clear();
  emitters.clear();
  mainWindowSender = undefined;
  registerNuwaxBridgeHandlers({
    getMainWindow: () =>
      ({
        webContents: {
          send: (c: string, p: unknown) => mainWindowSender?.(c, p),
        },
      }) as never,
  } as never);
  settings.set("step1_config", { serverHost: HOST_ORIGIN });
  settings.set("nuwax.loopback", { enabled: true, origin: GW_ORIGIN });
  handlers.get("auth:getToken")!(senderEvent(GW_ORIGIN));
});

describe("token 键空间统一（网关形态）", () => {
  it("getToken：sender 键为空 → serverHost 键回退并回写 sender 键", async () => {
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`, "OLD-TOKEN");
    const token = (await handlers.get("auth:getToken")!(
      senderEvent(GW_ORIGIN),
    )) as string;
    expect(token).toBe("OLD-TOKEN");
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`)).toBe(
      "OLD-TOKEN",
    );
  });

  it("persistToken：双写 sender + serverHost（网关键）——代注源不再拿空/陈旧", async () => {
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`, "STALE");
    const ok = (await handlers.get("auth:persistToken")!(
      senderEvent(GW_ORIGIN),
      "FRESH",
    )) as boolean;
    expect(ok).toBe(true);
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`)).toBe("FRESH");
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`)).toBe(
      "FRESH",
    );
  });

  it("clear：全清候选键——过期 token 不被回退链复活（死循环修复）", async () => {
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`, "EXPIRED");
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`, "EXPIRED");
    await handlers.get("auth:clear")!(senderEvent(GW_ORIGIN));
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`)).toBeNull();
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`)).toBeNull();
    // 清后再取：回退链无键可复活
    const again = await handlers.get("auth:getToken")!(senderEvent(GW_ORIGIN));
    expect(again).toBeNull();
  });

  it("clear：清登录态键但保留注册凭据族（登出≠注销设备，2026-09-14 语义收口）", async () => {
    settings.set("auth.saved_key", "sk");
    settings.set("auth.config_key", "ck");
    settings.set("auth.username", "user1");
    settings.set("auth.user_info", { username: "user1" });
    settings.set("auth.saved_keys.example.com_user1", "sk1");
    settings.set("auth.saved_keys.example.com_user2", "sk2");
    await handlers.get("auth:clear")!(senderEvent(GW_ORIGIN));
    // 登录态清（user_info/saved_keys.* 域名级派生缓存批删）
    expect(settings.get("auth.user_info")).toBeNull();
    expect(settings.get("auth.saved_keys.example.com_user1")).toBeUndefined();
    expect(settings.get("auth.saved_keys.example.com_user2")).toBeUndefined();
    // 注册凭据族保留：后端 reg 仍要 savedKey，清掉后同设备重登永远无法重新
    // 注册；跨账号由 persistToken 的账号切换检测清除。
    expect(settings.get("auth.saved_key")).toBe("sk");
    expect(settings.get("auth.username")).toBe("user1");
  });
});

describe("全新安装（step1_config 无 serverHost，dev 直连形态）", () => {
  it("persistToken：双写 sender + 业务域缺省键——reg 门禁读键不再为空（Login required 修复）", async () => {
    // 复刻 dev 全新库：无 serverHost（仅打包版首启种值）、网关未启用、
    // webview 经 NUWAX_WEBVIEW_ORIGIN 直连本地前端
    settings.set("step1_config", {});
    settings.set("nuwax.loopback", { enabled: false, origin: null });
    settings.set("nuwax.webviewOverride", { origin: DEV_ORIGIN });
    // getToken 先行：准入（override 命中）并注册文档，persistToken 才会受理
    await handlers.get("auth:getToken")!(senderEvent(DEV_ORIGIN));
    const ok = (await handlers.get("auth:persistToken")!(
      senderEvent(DEV_ORIGIN),
      "FRESH-DEV",
    )) as boolean;
    expect(ok).toBe(true);
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${DEV_ORIGIN}`)).toBe(
      "FRESH-DEV",
    );
    // 业务域候选回落 DEFAULT_SERVER_HOST（currentBusinessOrigin 同源逻辑）
    expect(
      settings.get(
        `${NUWAX_TOKEN_KEY_PREFIX}${new URL(DEFAULT_SERVER_HOST).origin}`,
      ),
    ).toBe("FRESH-DEV");
    // 网关未启用不写网关键
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`)).toBeUndefined();
  });
});

describe("configureServerHost（企业登录切换域名）", () => {
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
      `${GW_ORIGIN}/api/computer/static/photo.png`,
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
    expect(res.error).toBe("invalid url");
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
});

describe("语言同步（webview 多语言 → 壳）", () => {
  it("nuwax:lang-sync → 转发 nuwax:lang-changed 给壳 renderer", () => {
    const sent: [string, unknown][] = [];
    mainWindowSender = (c, p) => sent.push([c, p]);

    const emit = emitters.get("nuwax:lang-sync")?.[0];
    expect(emit).toBeDefined();
    emit!(undefined, { lang: "en-US" });

    const changed = sent.find(([c]) => c === "nuwax:lang-changed");
    expect(changed).toBeDefined();
    expect(changed![1]).toEqual({ lang: "en-US" });
  });

  it("非法/空语言 → 不转发", () => {
    const sent: [string, unknown][] = [];
    mainWindowSender = (c, p) => sent.push([c, p]);

    const emit = emitters.get("nuwax:lang-sync")?.[0];
    emit!(undefined, { lang: "   " });
    emit!(undefined, { lang: 123 });
    emit!(undefined, null);

    expect(sent.some(([c]) => c === "nuwax:lang-changed")).toBe(false);
  });
});

describe("document session isolation", () => {
  it("rejects token from a document invalidated by domain switch", async () => {
    const result = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN),
      "https://new.example.com",
    )) as any;
    expect(result.success).toBe(true);
    expect(
      await handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), "OLD"),
    ).toBe(false);
    expect(
      settings.get(`${NUWAX_TOKEN_KEY_PREFIX}https://new.example.com`),
    ).toBeNull();
  });
  it("reports failed stop and does not change domain", async () => {
    mocks.stop.mockResolvedValueOnce({ success: false, results: {} });
    const result = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN),
      "https://new.example.com",
    )) as any;
    expect(result.success).toBe(false);
    expect((settings.get("step1_config") as any).serverHost).toBe(HOST_ORIGIN);
  });
  it("改域硬重载后的新文档经 getToken 重注册 → persistToken 恢复受理（登录态进壳修复 2026-09-18）", async () => {
    // 换域 = authGeneration++ + 硬重载 webview；重载出的新文档与旧文档同
    // documentKey（webContents+frame 标识），此前的代次守卫把它当过期文档
    // 静默拒绝且不重注册 → persistToken 零日志失败 → 壳永远收不到登录态。
    const result = (await handlers.get("auth:configureServerHost")!(
      senderEvent(GW_ORIGIN),
      "https://new.example.com",
    )) as any;
    expect(result.success).toBe(true);
    // 迟到写保护不变：代次 bump 后未经 getToken 重注册的直接写仍拒绝
    expect(
      await handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), "OLD"),
    ).toBe(false);
    // 重载后的新文档：getInitialState 先 getToken（重注册），登录 persistToken 受理
    const NEW_ORIGIN = "https://new.example.com";
    await handlers.get("auth:getToken")!(senderEvent(NEW_ORIGIN));
    expect(
      await handlers.get("auth:persistToken")!(senderEvent(NEW_ORIGIN), "FRESH"),
    ).toBe(true);
    expect(
      settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${NEW_ORIGIN}`),
    ).toBe("FRESH");
  });
  it("登出（auth:clear）硬重载后的新文档同样经 getToken 重注册恢复受理", async () => {
    await handlers.get("auth:clear")!(senderEvent(GW_ORIGIN));
    // 登出也 authGeneration++ + 硬重载：新文档 getToken 重注册 → 重登可入壳
    await handlers.get("auth:getToken")!(senderEvent(GW_ORIGIN));
    expect(
      await handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), "RE"),
    ).toBe(true);
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${GW_ORIGIN}`)).toBe("RE");
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`)).toBe("RE");
  });
});


describe("login synchronization generation boundary", () => {
  it.each(["same-account", "different-account"])("preserves savedKey only for the same account after logout: %s", async (account) => {
    const payload = Buffer.from(JSON.stringify({ sub: account })).toString("base64url");
    settings.set("auth.username", "same-account");
    settings.set("auth.saved_key", "device-key");
    await handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), `header.${payload}.signature`);
    expect(settings.get("auth.saved_key")).toBe(account === "same-account" ? "device-key" : null);
  });

  it("ignores a cookie from an old jar when a new token is persisted", async () => {
    mocks.cookiesGet.mockResolvedValue([{ value: "old" }] as never);
    await handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), "new");
    expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBeNull();
    expect(settings.get(`nuwax.ticket.${GW_ORIGIN}`)).toBeNull();
  });

  it("captures the matching cookie even when another ticket appears first", async () => {
    mocks.cookiesGet.mockResolvedValue([{ value: "old" }, { value: "new" }] as never);
    await handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), "new");
    expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBe("new");
  });

  it("logout during cookie capture prevents late mirror writes and login notification", async () => {
    let resolve!: (value: never[]) => void;
    mocks.cookiesGet.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const notices: unknown[] = [];
    mainWindowSender = (channel, payload) => { if (channel === "nuwax:authChanged") notices.push(payload); };
    const pending = handlers.get("auth:persistToken")!(senderEvent(GW_ORIGIN), "new");
    await vi.waitFor(() => expect(mocks.cookiesGet).toHaveBeenCalled());
    await handlers.get("auth:clear")!(senderEvent(GW_ORIGIN));
    resolve([{ value: "new" }] as never);
    expect(await pending).toBe(false);
    expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBeNull();
    expect(settings.get(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`)).toBeNull();
    expect(notices).not.toContainEqual({ loggedIn: true });
  });

  it("rejects a background capture if the business origin changes", async () => {
    settings.set(`${NUWAX_TOKEN_KEY_PREFIX}${HOST_ORIGIN}`, "old");
    let resolve!: (value: never[]) => void;
    mocks.cookiesGet.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    handlers.get("auth:getToken")!(senderEvent(GW_ORIGIN));
    await vi.waitFor(() => expect(mocks.cookiesGet).toHaveBeenCalled());
    settings.set("step1_config", { serverHost: "https://new.example" });
    resolve([{ value: "old" }] as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(settings.get(`nuwax.ticket.${HOST_ORIGIN}`)).toBeUndefined();
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

  it("keeps a double-slash business pathname under the gateway authority", () => {
    handlers.get("native:openWindow")!(windowEvent(), { path: `${HOST_ORIGIN}//external.example/path?q=1#section` });
    expect(mocks.loadURL).toHaveBeenCalledWith(`${GW_ORIGIN}//external.example/path?q=1&_shell=1#section`);
    expect(new URL(mocks.loadURL.mock.calls[0][0]).origin).toBe(GW_ORIGIN);
  });

  it.each(["https://external.example/path", "http://testagent.xspaceagi.com/path", "https://username:password@testagent.xspaceagi.com/path"])("does not rewrite non-business or credentialed URLs: %s", (url) => {
    handlers.get("native:openWindow")!(windowEvent(), { path: url });
    expect(mocks.loadURL).toHaveBeenCalledWith(url);
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
});
