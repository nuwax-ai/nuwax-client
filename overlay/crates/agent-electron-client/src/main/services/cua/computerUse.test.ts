import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createHash, createHmac } from "node:crypto";
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
  daemonReady: false,
  autoReady: false,
  permissionGranted: false,
  policyActive: true,
  policyPath: "",
  captureReady: true,
  captureVerificationError: false,
  endpointProofValid: true,
  permissionGateAttempts: 0,
}));

function policyHash(policyPath: string): string {
  const name = path.basename(policyPath);
  const bytes = fs.readFileSync(policyPath);
  const size = (number: number) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(number));
    return buffer;
  };
  return createHash("sha256")
    .update("cua-driver-policy-v1\0")
    .update(size(Buffer.byteLength(name))).update(name)
    .update(size(bytes.length)).update(bytes).digest("hex");
}

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
    if (args.includes("stop")) mocks.daemonReady = false;
    const stderr =
      cmd === "codesign"
        ? "Identifier=com.nuwax-ai.nuwax-computer-use\nTeamIdentifier=89GQ2RJVW7\n"
        : "";
    cb(null, { stdout: "", stderr });
  },
  spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    mocks.spawnCalls.push({ cmd, args, env: opts?.env });
    if (args.includes("serve") && mocks.autoReady) {
      mocks.daemonReady = true;
      mocks.policyPath = opts?.env?.CUA_DRIVER_MANAGED_POLICY_FILE ??
        args.find((arg) => arg.startsWith("CUA_DRIVER_MANAGED_POLICY_FILE="))?.split("=").slice(1).join("=") ?? "";
    }
    if (args.includes("__permissions-host-request")) {
      const resultFile = args[args.indexOf("--result-file") + 1];
      fs.writeFileSync(resultFile, JSON.stringify({ structuredContent: {
        accessibility: mocks.permissionGranted,
        screen_recording: mocks.permissionGranted,
        screen_recording_capturable: mocks.permissionGranted && mocks.captureReady,
        direct_capture_verification: mocks.permissionGranted && mocks.captureReady
          ? { bundle_id: "com.nuwax-ai.nuwax-computer-use" } : undefined,
        direct_capture_verification_error: mocks.captureVerificationError
          ? { code: "direct_capture_verification_store_failed" } : undefined,
        source: { attribution: "driver-daemon", bundle_id: "com.nuwax-ai.nuwax-computer-use" },
      } }));
    }
    return { unref: vi.fn(), on: vi.fn() };
  },
}));
vi.mock("node:net", () => ({
  default: {
    connect: () => {
      const listeners: Record<string, (...args: any[]) => void> = {};
      const socket = {
        setTimeout: vi.fn(),
        destroy: vi.fn(),
        on: (event: string, callback: (...args: any[]) => void) => {
          listeners[event] = callback;
          return socket;
        },
        write: (payload: string) => {
          const request = JSON.parse(payload) as { method: string; args?: { nuwax_nonce?: string } };
          let reply: unknown = { ok: false };
          if (request.method === "metadata") {
            if (request.args?.nuwax_nonce) {
              const token = fs.readFileSync(endpointTokenFile(), "utf8");
              const proof = createHmac("sha256", token).update(request.args.nuwax_nonce).digest("hex");
              reply = { ok: true, result: { nuwax_endpoint_proof: mocks.endpointProofValid ? proof : "0".repeat(64) } };
            } else {
              reply = { ok: true, result: { driver_version: "0.28.2" } };
            }
          } else if (request.method === "authorization_status") {
            reply = { ok: true, result: {
              permission_mode: "unrestricted",
              permission_mode_valid: true,
              managed_policy_active: mocks.policyActive,
              managed_policy_valid: mocks.policyActive,
              managed_policy_sha256: mocks.policyPath ? policyHash(mocks.policyPath) : "",
            } };
          } else if (request.method === "call") {
            reply = mocks.permissionGateAttempts-- > 0
              ? { ok: false, error: "permissions_pending" }
              : { ok: true, result: { structuredContent: {
              accessibility: mocks.permissionGranted,
              screen_recording: mocks.permissionGranted,
              source: { attribution: "driver-daemon", bundle_id: "com.nuwax-ai.nuwax-computer-use" },
            } } };
          }
          queueMicrotask(() => listeners.data?.(Buffer.from(`${JSON.stringify(reply)}\n`)));
        },
      };
      queueMicrotask(() => listeners[mocks.daemonReady ? "connect" : "error"]?.());
      return socket;
    },
  },
}));
vi.mock("../packages/mcp", () => ({
  syncMcpConfigToProxyAndReload: mocks.proxySync,
}));

import {
  ensureCuaOnBoot,
  getCuaStatus,
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

function endpointTokenFile(): string {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(mocks.userDataURL, "computer-use", "endpoint.json"), "utf8",
  )) as { tokenFile: string };
  return manifest.tokenFile;
}

function readMcpServers(): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; allowTools?: string[]; denyTools?: string[] }> {
  const raw = mocks.settings.get("mcp_local_config") as string | undefined;
  return raw ? (JSON.parse(raw).mcpServers ?? {}) : {};
}

beforeEach(() => {
  mocks.settings.clear();
  mocks.proxySync.mockReset().mockResolvedValue(undefined);
  mocks.spawnCalls.length = 0;
  mocks.execCalls.length = 0;
  mocks.userDataURL = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-"));
  mocks.daemonReady = false;
  mocks.autoReady = false;
  mocks.permissionGranted = false;
  mocks.policyActive = true;
  mocks.policyPath = "";
  mocks.captureReady = true;
  mocks.captureVerificationError = false;
  mocks.endpointProofValid = true;
  mocks.permissionGateAttempts = 0;
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
    expect(entry!.allowTools).toContain("click");
    expect(entry!.allowTools).not.toContain("check_for_update");
    expect(entry!.denyTools).toEqual(["check_for_update", "install_ffmpeg"]);
    expect(entry!.env?.CUA_DRIVER_NUWAX_TOKEN_FILE).toBe(endpointTokenFile());
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
    expect(mocks.execCalls.some((c) => c.args.includes(path.join(os.tmpdir(), "nuwax-computer-use.sock")))).toBe(true);
  });

  it("未安装时开启→失败且不落开关", async () => {
    const r = await setCuaEnabled(true);
    expect(r.success).toBe(false);
    expect(r.error).toBe("bundledNotFound");
    expect((mocks.settings.get("step1_config") as Record<string, unknown>).computerUseEnabled).toBe(false);
  });

  it("关闭时清理旧固定端点与丢失 manifest 的随机端点孤儿进程", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    await syncCuaMcpConfig(true);
    fs.rmSync(path.join(mocks.userDataURL, "computer-use", "endpoint.json"));
    const result = await setCuaEnabled(false);
    expect(result.success).toBe(true);
    expect(mocks.execCalls.some((call) => call.args.includes(path.join(os.tmpdir(), "nuwax-computer-use.sock")))).toBe(true);
    expect(mocks.execCalls.some((call) => call.cmd === "pkill" &&
      call.args.some((arg) => arg.includes("Nuwax Computer Use.*serve --socket")))).toBe(true);
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

  it("macOS 双权限未获准→开关保持关闭且不注入 MCP", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("permissionsRequired");
    expect(result.status.enabled).toBe(false);
    expect(readMcpServers().cua).toBeUndefined();
    expect(mocks.spawnCalls.some((c) => c.args.includes("serve"))).toBe(false);
  });

  it("macOS 一次授权双通过、策略生效且 daemon 就绪后才启用", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(true);
    expect(result.status.enabled).toBe(true);
    expect(result.status.accessibility).toBe(true);
    expect(result.status.screenRecording).toBe(true);
    expect(readMcpServers().cua).toBeTruthy();
    expect(result.status.socketPath).toMatch(/\/c-[0-9a-f]{32}\/s$/);
    expect(fs.statSync(path.dirname(result.status.socketPath)).mode & 0o077).toBe(0);
    expect(fs.statSync(endpointTokenFile()).mode & 0o077).toBe(0);
    const serve = mocks.spawnCalls.find((c) => c.args.includes("serve"));
    expect(serve!.args).toContain("--dangerously-bypass-approvals");
    expect(serve!.args.some((arg) => arg.startsWith("CUA_DRIVER_MANAGED_POLICY_FILE="))).toBe(true);

    mocks.permissionGranted = false;
    const revoked = await getCuaStatus();
    expect(revoked.enabled).toBe(false);
    expect(readMcpServers().cua).toBeUndefined();
  });

  it("直接捕获未就绪时拒绝启用，并保留一次确认待办供设置页重挂载恢复", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.captureReady = false;
    const first = await setCuaEnabled(true);
    expect(first.success).toBe(false);
    expect(first.error).toBe("permissionsRequired");
    expect(first.status.consentPending).toBe(true);
    expect(readMcpServers().cua).toBeUndefined();

    vi.resetModules();
    const reopened = await import("./computerUse");
    expect((await reopened.getCuaStatus()).consentPending).toBe(true);
    mocks.captureReady = true;
    mocks.autoReady = true;
    const retried = await reopened.setCuaEnabled(true);
    expect(retried.success).toBe(true);
    expect(retried.status.consentPending).toBe(false);
  });

  it("daemon 初启权限 gate pending 会有界重试后启用", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    mocks.permissionGateAttempts = 2;
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(true);
    expect(mocks.permissionGateAttempts).toBeLessThan(0);
  });

  it("直接捕获证据写入失败时拒绝启用", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.captureVerificationError = true;
    mocks.autoReady = true;
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("permissionsRequired");
    expect(mocks.spawnCalls.some((call) => call.args.includes("serve"))).toBe(false);
  });

  it("端点没有正确 HMAC 证明时视为未运行", async () => {
    mocks.daemonReady = true;
    mocks.endpointProofValid = false;
    expect((await getCuaStatus()).running).toBe(false);
  });

  it("启动收敛与用户关闭并发，关闭完成后不得重新注入 MCP 或重启 daemon", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.proxySync.mockImplementation(async (servers: Record<string, unknown>) => {
      if (servers.cua) { entered(); await blocked; }
    });
    const boot = ensureCuaOnBoot();
    await reached;
    const off = setCuaEnabled(false);
    release();
    await Promise.all([boot, off]);
    const after = await getCuaStatus();
    expect(after.enabled).toBe(false);
    expect(after.running).toBe(false);
    expect(after.mcpInjected).toBe(false);
  });

  it("显式启用与关闭并发，关闭请求会取消尚未持久化的启用", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.proxySync.mockImplementation(async (servers: Record<string, unknown>) => {
      if (servers.cua) { entered(); await blocked; }
    });
    const enabling = setCuaEnabled(true);
    await reached;
    const disabling = setCuaEnabled(false);
    release();
    const [on, off] = await Promise.all([enabling, disabling]);
    expect(on.success).toBe(false);
    expect(off.success).toBe(true);
    const final = await getCuaStatus();
    expect(final.enabled).toBe(false);
    expect(final.running).toBe(false);
    expect(final.mcpInjected).toBe(false);
  });

  it("策略握手未生效→拒绝开启、清理 daemon 和 MCP", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    mocks.policyActive = false;
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("policyNotActive");
    expect(result.status.enabled).toBe(false);
    expect(readMcpServers().cua).toBeUndefined();
  });

  it("启动收敛只做无提示探测，撤权时自动关闭", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    mocks.autoReady = true;
    await ensureCuaOnBoot();
    expect((mocks.settings.get("step1_config") as Record<string, unknown>).computerUseEnabled).toBe(false);
    expect(mocks.spawnCalls.some((c) => c.args.includes("__permissions-host-request"))).toBe(false);
  });

  it("设置页早于启动收敛读取状态时不误清除持久开关", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    const beforeBoot = await getCuaStatus();
    expect(beforeBoot.enabled).toBe(true);
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    await ensureCuaOnBoot();
    expect((await getCuaStatus()).enabled).toBe(true);
    expect(mocks.spawnCalls.some((c) => c.args.includes("__permissions-host-request"))).toBe(false);
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
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const before = fs.statSync(stableHelperPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await installCuaHelper();
    expect(r2.success).toBe(true);
    expect(fs.statSync(stableHelperPath()).mtimeMs).toBe(before);
  });

  it("bundled 内容升级→稳定路径更新并记录新校验值", async () => {
    const stable = makeHelperApp(path.dirname(stableHelperPath()));
    const bundled = makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    fs.writeFileSync(path.join(bundled, "Contents", "MacOS", "Nuwax Computer Use"), "v2");
    const result = await installCuaHelper();
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(stable, "Contents", "MacOS", "Nuwax Computer Use"), "utf8")).toBe("v2");
    const lock = JSON.parse(fs.readFileSync(path.join(mocks.userDataURL, "computer-use", ".install-lock"), "utf8"));
    expect(lock.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("升级切换失败→恢复旧 helper", async () => {
    const stable = makeHelperApp(path.dirname(stableHelperPath()));
    const bundled = makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    fs.writeFileSync(path.join(bundled, "Contents", "MacOS", "Nuwax Computer Use"), "v2");
    const originalRename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".stage-") && String(to) === stable) {
        throw new Error("simulated rename failure");
      }
      return originalRename(from, to);
    });
    try {
      const result = await installCuaHelper();
      expect(result.success).toBe(false);
      expect(fs.readFileSync(path.join(stable, "Contents", "MacOS", "Nuwax Computer Use"), "utf8")).toBe("#!/bin/sh\n");
    } finally {
      spy.mockRestore();
    }
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

  it("setCuaEnabled(true)→spawn 注入 CUA_DRIVER_DATA_HOME 和托管策略", async () => {
    mocks.userDataURL = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-linux-"));
    Object.defineProperty(process, "resourcesPath", {
      value: path.join(mocks.userDataURL, "resources"),
      configurable: true,
    });
    const installedDir = path.join(mocks.userDataURL, "computer-use");
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "NuwaxComputerUse"), "#!/bin/sh\n");
    const bundledDir = path.join(process.resourcesPath as string, "computer-use");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "NuwaxComputerUse"), "#!/bin/sh\n");
    mocks.autoReady = true;

    const mod = await import("./computerUse");
    const r = await mod.setCuaEnabled(true);
    expect(r.success).toBe(true);

    const call = mocks.spawnCalls.find(
      (c) => c.cmd.endsWith("NuwaxComputerUse") && c.args.includes("serve"),
    );
    expect(call).toBeTruthy();
    // cuaDataHome = <home>/<APP_DATA_DIR_NAME>/computer-use（测试环境 home=mock userDataURL）
    expect(call!.env?.CUA_DRIVER_DATA_HOME).toMatch(/computer-use$/);
    expect(call!.env?.CUA_DRIVER_MANAGED_POLICY_FILE).toMatch(/nuwax-capabilities\.yaml$/);
    expect(call!.args).toContain("unrestricted");
    expect(call!.args).toContain("--dangerously-bypass-approvals");
    const policy = fs.readFileSync(call!.env!.CUA_DRIVER_MANAGED_POLICY_FILE!, "utf8");
    expect(policy).toContain("    - click");
    expect(policy).toContain("    - check_for_update");
  });
});
