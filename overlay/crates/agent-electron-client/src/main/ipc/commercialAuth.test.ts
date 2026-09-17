import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  fetch: vi.fn(),
  isPackaged: true,
}));
vi.mock("electron", () => ({
  // getter 双向绑定：dev 种值分支测试可按用例切 isPackaged
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
  },
  net: { fetch: mocks.fetch },
}));
vi.mock("../db", () => ({
  readSetting: (k: string) => mocks.settings.get(k) ?? null,
  writeSetting: (k: string, v: unknown) => mocks.settings.set(k, v),
  getDb: () => ({
    prepare: () => ({
      run: () => {
        for (const k of mocks.settings.keys())
          if (k.startsWith("auth.saved_keys.") || k.startsWith("auth.tokens."))
            mocks.settings.delete(k);
      },
    }),
  }),
}));
vi.mock("../services/startupPorts", () => ({
  getConfiguredPorts: () => ({ agent: 61006, fileServer: 61005, ttyd: 61009 }),
}));
vi.mock("../services/system/deviceId", () => ({
  getDeviceId: () => "commercial-device",
}));
vi.mock("os", () => ({
  hostname: () => "fengfei-mac-xx.local",
}));
import {
  clearRegistration,
  getComputerName,
  initializeCommercialAuth,
  readTicketCookieValue,
  writeTicketForScopes,
} from "./commercialAuth";
const origin = "https://enterprise.example.com";
function fixture() {
  const start = vi.fn(async () => ({ success: true }));
  const stop = vi.fn(async () => ({ success: true }));
  return { flow: initializeCommercialAuth(start, stop, vi.fn()), start, stop };
}
beforeEach(() => {
  mocks.settings.clear();
  mocks.fetch.mockReset();
  mocks.isPackaged = true;
  delete process.env.NUWAX_SERVER_HOST;
});
describe("commercial registration protocol", () => {
  it("fresh installation selects bundled UI without importing legacy credentials", () => {
    fixture();
    expect(mocks.settings.get("step1_config")).toMatchObject({
      // 测试期默认域=测试环境（overlay 种子；恢复正式改回 DEFAULT_SERVER_HOST）
      serverHost: "https://testagent.xspaceagi.com",
      nuwaxLoadMode: "gateway",
    });
    expect(mocks.settings.get("auth.saved_key")).toBeNull();
  });
  it("device identity upgrade clears registration but preserves web login + savedKey", () => {
    mocks.settings.set("step1_config", { serverHost: origin });
    mocks.settings.set(`nuwax.accessToken.${origin}`, "web-token");
    mocks.settings.set("auth.saved_key", "old-device-key");
    mocks.settings.set("auth.config_key", "old-config");
    mocks.settings.set("auth.saved_keys.old.example_user", "domain-key");
    mocks.settings.set("lanproxy_config", {
      serverIp: "old",
      serverPort: 123,
      ssl: true,
    });
    fixture();
    expect(mocks.settings.get(`nuwax.accessToken.${origin}`)).toBe("web-token");
    // savedKey 是唯一能重新注册的凭据（后端必查；实测接受旧 savedKey+新
    // deviceId）——盐变更迁移时保留，否则存量用户升级后永远无法注册。
    expect(mocks.settings.get("auth.saved_key")).toBe("old-device-key");
    expect(mocks.settings.get("auth.config_key")).toBeNull();
    expect(mocks.settings.get("auth.saved_keys.old.example_user")).toBeUndefined();
    expect(mocks.settings.get("lanproxy_config")).toEqual({ ssl: true });
    expect(mocks.settings.get("nuwax.registrationDeviceId")).toBe(
      "commercial-device",
    );
  });
  it("registers with token and product device, commits before starting", async () => {
    mocks.settings.set("step1_config", { serverHost: origin });
    mocks.settings.set(`nuwax.accessToken.${origin}`, "opaque-token");
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "0000",
          data: {
            configKey: "new",
            serverHost: "tunnel.example.com",
            serverPort: 443,
          },
        }),
      ),
    );
    const { flow, start } = fixture();
    expect((await flow.start()).success).toBe(true);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe(origin + "/api/sandbox/config/reg");
    expect(options.headers.Authorization).toBe("Bearer opaque-token");
    const body = JSON.parse(options.body);
    expect(body.deviceId).toBe("commercial-device");
    // 电脑名三平台取 os.hostname，剥 macOS .local 尾巴后上报
    expect(body.computerName).toBe("fengfei-mac-xx");
    expect(getComputerName()).toBe("fengfei-mac-xx");
    expect(body.savedKey).toBeUndefined();
    expect(body.sandboxConfigValue.fileServerPort).toBe(61005);
    // 无已同步 ticket：不附 Cookie（存量行为回归）
    expect(options.headers.Cookie).toBeUndefined();
    expect(mocks.settings.get("auth.config_key")).toBe("new");
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("reg 附登录会话 ticket cookie（无 savedKey 的首次设备注册凭据）", async () => {
    mocks.settings.set("step1_config", { serverHost: origin });
    mocks.settings.set(`nuwax.accessToken.${origin}`, "opaque-token");
    // 网关域键命中优先级其次；此处业务域键命中即可验证候选序回读
    mocks.settings.set(`nuwax.ticket.${origin}`, "session-ticket-value");
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "0000",
          data: { configKey: "k1", serverHost: "t.example.com", serverPort: 443 },
        }),
      ),
    );
    const { flow } = fixture();
    expect((await flow.start()).success).toBe(true);
    const [, options] = mocks.fetch.mock.calls[0];
    expect(options.headers.Cookie).toBe("ticket=session-ticket-value");
    expect(options.headers.Authorization).toBe("Bearer opaque-token");
  });
  it("readTicketCookieValue 按候选序回读，writeTicketForScopes 双写/清", () => {
    writeTicketForScopes(
      ["https://a.example.com", "http://127.0.0.1:46800"],
      "t-1",
    );
    expect(readTicketCookieValue(["https://a.example.com"])).toBe("t-1");
    // 首候选缺失时回退次候选（直连↔gateway 双形态）
    expect(
      readTicketCookieValue(["https://missing.example.com", "http://127.0.0.1:46800"]),
    ).toBe("t-1");
    expect(readTicketCookieValue(["https://missing.example.com"])).toBeNull();
    writeTicketForScopes(
      ["https://a.example.com", "http://127.0.0.1:46800"],
      null,
    );
    expect(readTicketCookieValue(["https://a.example.com"])).toBeNull();
  });
  it("late HTTP result after logout never commits or starts", async () => {
    mocks.settings.set("step1_config", { serverHost: origin });
    mocks.settings.set(`nuwax.accessToken.${origin}`, "token");
    let resolve!: (r: Response) => void;
    mocks.fetch.mockReturnValue(new Promise((r) => (resolve = r)));
    const { flow, start } = fixture();
    const pending = flow.start();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const stopped = flow.stop();
    resolve(
      new Response(
        JSON.stringify({
          code: "0000",
          data: { configKey: "late", serverHost: "old", serverPort: 443 },
        }),
      ),
    );
    await pending;
    await stopped;
    expect(mocks.settings.get("auth.config_key")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
  it("does not start on incomplete or rejected registration", async () => {
    mocks.settings.set("step1_config", { serverHost: origin });
    mocks.settings.set(`nuwax.accessToken.${origin}`, "token");
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ code: "4000", message: "Password required" }),
      ),
    );
    const { flow, start } = fixture();
    expect((await flow.start()).success).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("dev 首启种值（NUWAX_SERVER_HOST 旋钮）", () => {
  it("dev 全新库 + env → 种 serverHost（直连形态，不种 gateway）", () => {
    mocks.isPackaged = false;
    process.env.NUWAX_SERVER_HOST = "https://testagent.xspaceagi.com";
    try {
      fixture();
      expect(mocks.settings.get("step1_config")).toEqual({
        serverHost: "https://testagent.xspaceagi.com",
      });
    } finally {
      delete process.env.NUWAX_SERVER_HOST;
    }
  });
  it("dev 全新库无 env → 不种值（业务域候选由 nuwaxTokenScopes 缺省兜底对齐）", () => {
    mocks.isPackaged = false;
    fixture();
    expect(mocks.settings.has("step1_config")).toBe(false);
  });
});

describe("clearRegistration 注册凭据语义（2026-09-14 收口）", () => {
  beforeEach(() => {
    mocks.settings.clear();
    mocks.settings.set("auth.saved_key", "sk-1");
    mocks.settings.set("auth.config_key", "sk-1");
    mocks.settings.set("auth.username", "18000000000");
    mocks.settings.set("lanproxy_config", {
      serverIp: "old",
      serverPort: 123,
      enabled: true,
    });
  });

  it("默认全清（换账号/换域场景）：savedKey/username/configKey/lanproxy 指针全清", () => {
    clearRegistration();
    expect(mocks.settings.get("auth.saved_key")).toBeNull();
    expect(mocks.settings.get("auth.config_key")).toBeNull();
    expect(mocks.settings.get("auth.username")).toBeNull();
    expect(mocks.settings.get("lanproxy_config")).toEqual({ enabled: true });
  });

  it("preserveSavedKey=true（token 过期重登/登出/设备盐变更）：savedKey+username 成对保留，其余照清", () => {
    clearRegistration({ preserveSavedKey: true });
    expect(mocks.settings.get("auth.saved_key")).toBe("sk-1");
    expect(mocks.settings.get("auth.username")).toBe("18000000000");
    expect(mocks.settings.get("auth.config_key")).toBeNull();
    expect(mocks.settings.get("lanproxy_config")).toEqual({ enabled: true });
  });

  it("preserveSavedKey 且无历史凭据（真首登）→ 不凭空造值", () => {
    mocks.settings.delete("auth.saved_key");
    mocks.settings.delete("auth.username");
    clearRegistration({ preserveSavedKey: true });
    // mock 的 writeSetting(null) = set null（真实库为删除），此处语义 = 无值
    expect(mocks.settings.get("auth.saved_key")).toBeNull();
    expect(mocks.settings.get("auth.username")).toBeNull();
  });
});
