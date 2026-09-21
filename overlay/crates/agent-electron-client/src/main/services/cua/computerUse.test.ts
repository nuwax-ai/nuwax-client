import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  proxySync: vi.fn(),
  spawnCalls: [] as Array<{
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }>,
  execCalls: [] as Array<{ cmd: string; args: string[] }>,
  userDataURL: "",
}));

// mac 分支在本仓开发机/CI mac runner 上生效；win 分支随 B4 真机验证
vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => mocks.userDataURL,
    // 打包态：/Applications dev 回退不生效（本机 spike 装的 helper 不得污染测试）
    isPackaged: true,
    on: vi.fn(),
  },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../db", () => ({
  readSetting: (k: string) => mocks.settings.get(k) ?? null,
  writeSetting: (k: string, v: unknown) => void mocks.settings.set(k, v),
  getDb: () => ({
    prepare: () => ({
      // mcp_local_config 原始 JSON 读写与 readSetting/writeSetting 同源（Map 后端）
      get: (k: string) =>
        mocks.settings.has(k)
          ? { value: mocks.settings.get(k) }
          : undefined,
      run: (k: string, v: string) => void mocks.settings.set(k, v),
    }),
  }),
}));
vi.mock("node:child_process", () => ({
  // 元数无关：pexec(cmd,args) 与 pexec(cmd,args,opts) 两种调用形态，回调总在末位
  execFile: (...invoke: unknown[]) => {
    const cb = invoke[invoke.length - 1] as (
      e: unknown,
      r: { stdout: string; stderr: string },
    ) => void;
    const cmd = invoke[0] as string;
    const args = invoke[1] as string[];
    mocks.execCalls.push({ cmd, args });
    const stderr =
      cmd === "codesign"
        ? "Identifier=com.nuwax-ai.nuwax-computer-use\nTeamIdentifier=89GQ2RJVW7\n"
        : "";
    cb(null, { stdout: "", stderr });
  },
  spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    mocks.spawnCalls.push({ cmd, args, env: opts?.env });
    return { unref: vi.fn() };
  },
}));
vi.mock("../packages/mcp", () => ({
  syncMcpConfigToProxyAndReload: mocks.proxySync,
}));

import {
  ensureCuaOnBoot,
  installCuaHelper,
  setCuaEnabled,
  syncCuaMcpConfig,
} from "./computerUse";

const HELPER_APP = "Nuwax Computer Use.app";

function makeHelperApp(root: string) {
  const app = path.join(root, HELPER_APP);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Nuwax Computer Use"), "#!/bin/sh\n");
  return app;
}

function stableHelperPath(): string {
  return path.join(mocks.userDataURL, "computer-use", HELPER_APP);
}

function readMcpServers(): Record<string, { command?: string; args?: string[] }> {
  const raw = mocks.settings.get("mcp_local_config") as string | undefined;
  return raw ? (JSON.parse(raw).mcpServers ?? {}) : {};
}

beforeEach(() => {
  mocks.settings.clear();
  mocks.proxySync.mockReset().mockResolvedValue(undefined);
  mocks.spawnCalls.length = 0;
  mocks.execCalls.length = 0;
  mocks.userDataURL = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-"));
  // 测试进程无 resourcesPath：指到临时 bundled 目录（可按用例放置假 bundled helper）
  Object.defineProperty(process, "resourcesPath", {
    value: path.join(mocks.userDataURL, "resources"),
    configurable: true,
  });
});

describe("cua MCP 条目注入（guiMcpLocalConfig 先例模式）", () => {
  it("开关开→upsert cua stdio 条目并同步 Proxy", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    await syncCuaMcpConfig(true);
    const entry = readMcpServers().cua;
    expect(entry).toBeTruthy();
    expect(entry!.command).toBe(
      path.join(stableHelperPath(), "Contents", "MacOS", "Nuwax Computer Use"),
    );
    expect(entry!.args).toEqual(["mcp", "--socket", expect.any(String)]);
    expect(mocks.proxySync).toHaveBeenCalledTimes(1);
  });

  it("开关关→移除 cua 条目（其他条目不受影响）", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.settings.set(
      "mcp_local_config",
      JSON.stringify({
        mcpServers: {
          "other-server": { command: "foo", args: [] },
          cua: { command: "bar", args: ["mcp"] },
        },
      }),
    );
    await syncCuaMcpConfig(false);
    const servers = readMcpServers();
    expect(servers.cua).toBeUndefined();
    expect(servers["other-server"]).toEqual({ command: "foo", args: [] });
  });

  it("helper 已不存在时开启→不注入僵尸条目", async () => {
    await syncCuaMcpConfig(true);
    expect(readMcpServers().cua).toBeUndefined();
  });
});

describe("cua 开关与启动收敛", () => {
  it("setCuaEnabled(false)→持久化关闭+移除条目+协议停机", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.settings.set(
      "mcp_local_config",
      JSON.stringify({ mcpServers: { cua: { command: "x", args: [] } } }),
    );
    const r = await setCuaEnabled(false);
    expect(r.success).toBe(true);
    expect(readMcpServers().cua).toBeUndefined();
    expect(
      (mocks.settings.get("step1_config") as Record<string, unknown>)
        .computerUseEnabled,
    ).toBe(false);
    // 协议优先停机：走 helper 可执行 stop --socket
    expect(mocks.execCalls.some((c) => c.args.includes("stop"))).toBe(true);
  });

  it("未安装时开启→失败且不落开关", async () => {
    const r = await setCuaEnabled(true);
    expect(r.success).toBe(false);
    expect(r.error).toBe("helperNotInstalled");
    expect(mocks.settings.get("step1_config")).toBeUndefined();
  });

  it("ensureCuaOnBoot：开关开但 helper 消失→清理僵尸条目", async () => {
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    mocks.settings.set(
      "mcp_local_config",
      JSON.stringify({ mcpServers: { cua: { command: "x", args: [] } } }),
    );
    await ensureCuaOnBoot();
    expect(readMcpServers().cua).toBeUndefined();
  });
});

describe("首用安装流（Resources → userData 稳定路径）", () => {
  it("bundled helper→签名/bundle id 校验+拷贝+安装锁", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const r = await installCuaHelper();
    expect(r.success).toBe(true);
    expect(fs.existsSync(stableHelperPath())).toBe(true);
    expect(
      fs.existsSync(
        path.join(mocks.userDataURL, "computer-use", ".install-lock"),
      ),
    ).toBe(true);
    // 校验链：bundled 校验 + 安装后复验（codesign 被调多次），清 xattr、注册 LS
    const cmds = mocks.execCalls.map((c) => c.cmd);
    expect(cmds.filter((c) => c === "codesign").length).toBeGreaterThanOrEqual(2);
    expect(cmds).toContain("xattr");
  });

  it("无 bundled 源→bundled-not-found", async () => {
    const r = await installCuaHelper();
    expect(r.success).toBe(false);
    expect(r.error).toBe("bundledNotFound");
  });

  it("已安装→幂等成功，不再拷贝", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    const before = fs.statSync(stableHelperPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await installCuaHelper();
    expect(r2.success).toBe(true);
    expect(fs.statSync(stableHelperPath()).mtimeMs).toBe(before);
  });
});

describe("Windows 语义回归（stopDaemon 兜底通配须匹配命名管道路径）", () => {
  // 真 bug：兜底 PowerShell 的 CommandLine -like 模式曾为单段
  // `*serve --socket nuwax-computer-use*`，而 win 实际命令行是
  // `serve --socket \\.\pipe\nuwax-computer-use`（pipe 前缀打断连续子串），
  // 协议停失败时兜底恒杀不到。此处锁定两段通配的新模式。
  const WIN_CMDLINE = "NuwaxComputerUse.exe serve --socket \\\\.\\pipe\\nuwax-computer-use";
  const likeToRegex = (p: string) =>
    new RegExp("^" + p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");

  beforeAll(() => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    vi.resetModules();
  });
  afterAll(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    vi.resetModules();
  });

  it("无 helper（协议停跳过）→ PowerShell 兜底，通配模式与实际命令行匹配", async () => {
    mocks.userDataURL = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-win-"));
    Object.defineProperty(process, "resourcesPath", {
      value: path.join(mocks.userDataURL, "resources"),
      configurable: true,
    });

    const mod = await import("./computerUse");
    await mod.stopDaemon();

    const psCall = mocks.execCalls.find((c) => c.cmd === "powershell");
    expect(psCall).toBeTruthy();
    const likeMatch = psCall!.args[2].match(/-like '([^']+)'/);
    expect(likeMatch).toBeTruthy();
    const pattern = likeMatch![1];
    // 两段通配（吸收 \\.\pipe\ 前缀）匹配实际命令行；旧单段模式不匹配
    expect(likeToRegex(pattern).test(WIN_CMDLINE)).toBe(true);
    expect(
      likeToRegex("*serve --socket nuwax-computer-use*").test(WIN_CMDLINE),
    ).toBe(false);
    // win 不走 pkill
    expect(mocks.execCalls.some((c) => c.cmd === "pkill")).toBe(false);
  });
});

describe("Linux 语义回归（安装目标名必须与探测名同源）", () => {
  // 真 bug：installCuaHelper 的 dest 曾用 win/mac 二元判断（IS_WIN ? exe : .app），
  // Linux 装成 .app 名而探测找 NuwaxComputerUse → installed 恒 false、开关不可用。
  // 此前测试零 linux 覆盖故漏网——本组用平台覆写+模块重载补上。
  beforeAll(() => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    vi.resetModules();
  });
  afterAll(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    vi.resetModules();
  });

  it("bundled 裸二进制→安装落 NuwaxComputerUse 且 installed 探测可达+可执行位", async () => {
    mocks.userDataURL = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-linux-"));
    Object.defineProperty(process, "resourcesPath", {
      value: path.join(mocks.userDataURL, "resources"),
      configurable: true,
    });
    const bundledDir = path.join(process.resourcesPath as string, "computer-use");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "NuwaxComputerUse"), "#!/bin/sh\n");

    const mod = await import("./computerUse");
    const r = await mod.installCuaHelper();
    expect(r.success).toBe(true);

    const dest = path.join(mocks.userDataURL, "computer-use", "NuwaxComputerUse");
    expect(fs.existsSync(dest)).toBe(true);
    expect((fs.statSync(dest).mode & 0o111) !== 0).toBe(true);

    const s = await mod.getCuaStatus();
    expect(s.supported).toBe(true);
    expect(s.installed).toBe(true);
  });

  it("setCuaEnabled(true)→spawn 注入 CUA_DRIVER_DATA_HOME（数据目录内聚 ~/.nuwax）", async () => {
    mocks.userDataURL = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-linux-"));
    Object.defineProperty(process, "resourcesPath", {
      value: path.join(mocks.userDataURL, "resources"),
      configurable: true,
    });
    const installedDir = path.join(mocks.userDataURL, "computer-use");
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "NuwaxComputerUse"), "#!/bin/sh\n");

    const mod = await import("./computerUse");
    const r = await mod.setCuaEnabled(true); // socket 探活超时后仍会走注入（约 5s）
    expect(r.success).toBe(true);

    const call = mocks.spawnCalls.find(
      (c) => c.cmd.endsWith("NuwaxComputerUse") && c.args.includes("serve"),
    );
    expect(call).toBeTruthy();
    // cuaDataHome = <home>/<APP_DATA_DIR_NAME>/computer-use（测试环境 home=mock userDataURL）
    expect(call!.env?.CUA_DRIVER_DATA_HOME).toMatch(/computer-use$/);
  });
});
