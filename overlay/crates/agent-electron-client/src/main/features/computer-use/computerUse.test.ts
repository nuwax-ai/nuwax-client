import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createHash, createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  settingFailure: false,
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
  deferPermissionHost: false,
  permissionCleanupGate: undefined as Promise<void> | undefined,
  installGate: undefined as Promise<void> | undefined,
  policyActive: true,
  policyPath: "",
  captureReady: true,
  captureVerificationError: false,
  callerAttribution: false,
  endpointProofValid: true,
  permissionGateAttempts: 0,
  gatewayOptions: undefined as any,
  windowItems: undefined as Array<{ pid: number; window_id: number; app_name: string; title: string; [key: string]: unknown }> | undefined,
  nativeForeground: false,
  previewGate: undefined as Promise<void> | undefined,
  nativeRequests: [] as Array<{ name?: string; args?: any }>,
  drained: true,
  revokeOK: true,
  windowProbeGate: undefined as Promise<void> | undefined,
  windowProbeStarted: vi.fn(),
  beforeRawSocketError: undefined as (() => void) | undefined,
  rejectImplicitHostSession: false,
  hostRequests: [] as Array<{ method: string; name?: string; session_id?: string }>,
  closedHostSessions: [] as string[],
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
vi.mock("./mcpGateway", () => ({
  CUA_STDIO_RELAY: "relay",
  CuaMcpGateway: class {
    constructor(options: unknown) { mocks.gatewayOptions = options; }
    ready = false;
    async listen(socket: string) { this.ready = true; if (!socket.startsWith("\\\\")) fs.writeFileSync(socket, ""); }
    async close() { this.ready = false; }
    cancelPending() {}
    pauseTransports() {}
    async resumeTransports() {}
    holdOwner() {}
    async ownerDrained() {}
  },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    const gate = cmd === "codesign" ? mocks.installGate
      : cmd === "pkill" && args.some(arg => arg.includes("__permissions-host-request")) ? mocks.permissionCleanupGate : undefined;
    if (gate) { void gate.then(() => cb(null, { stdout: "", stderr })); return; }
    cb(null, { stdout: "", stderr });
  },
  spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    mocks.spawnCalls.push({ cmd, args, env: opts?.env });
    if (args.includes("serve") && mocks.autoReady) {
      mocks.daemonReady = true;
      mocks.policyPath = opts?.env?.CUA_DRIVER_MANAGED_POLICY_FILE ??
        args.find((arg) => arg.startsWith("CUA_DRIVER_MANAGED_POLICY_FILE="))?.split("=").slice(1).join("=") ?? "";
    }
    if (args.includes("__permissions-host-request") && !mocks.deferPermissionHost) {
      const resultFile = args[args.indexOf("--result-file") + 1];
      fs.writeFileSync(resultFile, JSON.stringify({ structuredContent: {
        accessibility: mocks.permissionGranted,
        screen_recording: mocks.permissionGranted,
        screen_recording_capturable: mocks.permissionGranted && mocks.captureReady,
        direct_capture_verification: mocks.permissionGranted && mocks.captureReady
          ? { bundle_id: "com.nuwax-ai.nuwax-computer-use" } : undefined,
        direct_capture_verification_error: mocks.captureVerificationError
          ? { code: "direct_capture_verification_store_failed" } : undefined,
        source: mocks.callerAttribution ? { attribution: "caller", bundle_id: null }
          : { attribution: "driver-daemon", bundle_id: "com.nuwax-ai.nuwax-computer-use" },
      } }));
    }
    return { unref: vi.fn(), on: vi.fn() };
  },
}));
vi.mock("node:net", async (importOriginal) => {
  const actualNet = await importOriginal<typeof import("node:net")>();
  return {
    default: {
      connect: (socketPath: string) => {
        const listeners: Record<string, (...args: any[]) => void> = {};
        let raw: import("node:net").Socket | undefined;
        let timeout: [number, (() => void) | undefined] | undefined;
        let hostSession: string | undefined;
        const socket = {
          setTimeout: (ms: number, callback?: () => void) => { timeout = [ms, callback]; raw?.setTimeout(ms, callback); },
          destroy: vi.fn(() => { raw?.destroy(); if (hostSession) { mocks.closedHostSessions.push(hostSession); hostSession = undefined; } }),
          on: (event: string, callback: (...args: any[]) => void) => {
            listeners[event] = callback;
            return socket;
          },
          write: (payload: string) => {
            const request = JSON.parse(payload) as { method: string; name?: string; session_id?: string; args?: { nuwax_nonce?: string } };
            mocks.hostRequests.push({ method: request.method, name: request.name, session_id: request.session_id });
            let reply: unknown = { ok: false };
            if (request.method === "metadata") {
              if (request.args?.nuwax_nonce) {
                const token = fs.readFileSync(endpointTokenFile(), "utf8");
                const proof = createHmac("sha256", token).update(request.args.nuwax_nonce).digest("hex");
                reply = { ok: true, result: { nuwax_endpoint_proof: mocks.endpointProofValid ? proof : "0".repeat(64) } };
              } else {
                reply = { ok: true, result: { driver_version: "0.28.2", nuwax_window_tasks: 1, nuwax_window_preview: 1 } };
              }
            } else if (request.method === "authorization_status") {
              reply = { ok: true, result: {
                permission_mode: "unrestricted",
                permission_mode_valid: true,
                managed_policy_active: mocks.policyActive,
                managed_policy_valid: mocks.policyActive,
                managed_policy_sha256: mocks.policyPath ? policyHash(mocks.policyPath) : "",
              } };
            } else if (request.method === "nuwax_task") {
              mocks.nativeRequests.push(request);
              reply = request.name === "revoke" && !mocks.revokeOK ? { ok: false } : request.name === "preview" ? { ok: true, result: { ...(request.args as any), width: 960, height: 540, jpeg: "A".repeat(100000) } }
                : { ok: true, result: { valid: true, activated: true, foreground: mocks.nativeForeground, drained: mocks.drained, tasks: [] } };
            } else if (request.method === "session_begin") {
              hostSession = request.session_id; reply = { ok: true, result: { session_begin: true } };
            } else if (request.method === "call" && mocks.rejectImplicitHostSession && (!request.session_id || request.session_id !== hostSession)) {
              reply = { ok: true, result: { isError: true, content: [{ type: "text", text: "this session has ended; call start_session explicitly to reuse its label" }], structuredContent: { code: "session_ended" } } };
            } else if (request.method === "call" && request.name === "list_windows") {
              reply = { ok: true, result: { structuredContent: { windows: mocks.windowItems ?? [{ pid: 25, window_id: 50, app_name: "Fixture", title: "Document" }] } } };
            } else if (request.method === "call") {
              reply = mocks.permissionGateAttempts-- > 0
                ? { ok: false, error: "permissions_pending" }
                : { ok: true, result: { structuredContent: {
                accessibility: mocks.permissionGranted,
                screen_recording: mocks.permissionGranted,
                source: { attribution: "driver-daemon", bundle_id: "com.nuwax-ai.nuwax-computer-use" },
              } } };
            }
            const answer = () => listeners.data?.(Buffer.from(`${JSON.stringify(reply)}\n`));
            if (request.method === "nuwax_task" && request.name === "preview" && mocks.previewGate) {
              void mocks.previewGate.then(() => listeners.data?.(Buffer.from(JSON.stringify(reply) + "\n"))); return;
            }
            if (request.method === "nuwax_task" && request.name === "window") {
              mocks.windowProbeStarted();
              if (mocks.windowProbeGate) { void mocks.windowProbeGate.then(answer); return; }
            }
            queueMicrotask(answer);
          },
        };
        queueMicrotask(() => {
          if (!listeners.data) {
            // The stale-path safety probe uses real Unix sockets; only protocol replies are mocked.
            raw = actualNet.connect(socketPath);
            if (timeout) raw.setTimeout(...timeout);
            raw.on("connect", () => listeners.connect?.());
            raw.on("close", () => listeners.close?.());
            raw.on("error", error => { mocks.beforeRawSocketError?.(); listeners.error?.(error); });
          } else if (mocks.daemonReady) listeners.connect?.();
          else listeners.error?.(Object.assign(new Error("not listening"), { code: "ECONNREFUSED" }));
        });
        return socket;
      },
    },
  };
});

/** 测试宿主双实现：与原 db/mcp mock 同一 Map 后端，断言形态不变。 */
function testHostPorts() {
  return {
    get dataHome() { return path.join(mocks.userDataURL, "computer-use"); },
    readSetting: (k: string) => mocks.settings.get(k) ?? null,
    writeSetting: (k: string, v: unknown) => {
      if (mocks.settingFailure) return false;
      mocks.settings.set(k, v);
      return true;
    },
    setLocalMcpServer: async (id: string, entry: unknown | null) => {
      const raw = mocks.settings.get("mcp_local_config") as string | undefined;
      const config = raw ? (JSON.parse(raw) as { mcpServers?: Record<string, unknown> }) : {};
      const servers = { ...(config.mcpServers ?? {}) };
      if (entry) servers[id] = entry;
      else delete servers[id];
      mocks.settings.set("mcp_local_config", JSON.stringify({ ...config, mcpServers: servers }));
      await mocks.proxySync(servers);
    },
    hasLocalMcpServer: (id: string) => !!readMcpServers()[id],
    resolveNodeBinary: () => "/bundled/node",
  };
}

async function loadCua(): Promise<CuaModule> {
  const mod = await import("./computerUse");
  const { configureComputerUseHost } = await import("./ports");
  configureComputerUseHost(testHostPorts());
  return mod;
}

type CuaModule = typeof import("./computerUse");
let cuaModule: CuaModule;
const ensureCuaOnBoot = (...args: Parameters<CuaModule["ensureCuaOnBoot"]>) =>
  cuaModule.ensureCuaOnBoot(...args);
const getCuaStatus = (...args: Parameters<CuaModule["getCuaStatus"]>) =>
  cuaModule.getCuaStatus(...args);
const installCuaHelper = (...args: Parameters<CuaModule["installCuaHelper"]>) =>
  cuaModule.installCuaHelper(...args);
const setCuaEnabled = (...args: Parameters<CuaModule["setCuaEnabled"]>) =>
  cuaModule.setCuaEnabled(...args);
const setCuaAgentCursorEnabled = (...args: Parameters<CuaModule["setCuaAgentCursorEnabled"]>) =>
  cuaModule.setCuaAgentCursorEnabled(...args);
const setCuaAuthMode = (...args: Parameters<CuaModule["setCuaAuthMode"]>) =>
  cuaModule.setCuaAuthMode(...args);
const setCuaBlacklist = (...args: Parameters<CuaModule["setCuaBlacklist"]>) =>
  cuaModule.setCuaBlacklist(...args);
const syncCuaMcpConfig = (...args: Parameters<CuaModule["syncCuaMcpConfig"]>) =>
  cuaModule.syncCuaMcpConfig(...args);

const originalPlatform = process.platform;
beforeAll(async () => {
  // The main suite exercises the macOS helper app and TCC flow on every runner.
  // Windows and Linux behavior is covered by the isolated platform suites below.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  cuaModule = await loadCua();
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

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

async function createEndpointSocket(stale: boolean) {
  const socketPath = (await getCuaStatus()).socketPath!;
  const actualNet = await vi.importActual<typeof import("node:net")>("node:net");
  const original = stale ? socketPath + ".fixture" : socketPath;
  const server = actualNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(original, resolve);
  });
  fs.chmodSync(original, 0o600);
  if (stale) {
    // Renaming leaves a real stale socket after libuv closes its original path.
    fs.renameSync(original, socketPath);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  return { socketPath, server };
}

beforeEach(() => {
  mocks.settings.clear();
  mocks.settingFailure = false;
  mocks.proxySync.mockReset().mockResolvedValue(undefined);
  mocks.spawnCalls.length = 0;
  mocks.execCalls.length = 0;
  mocks.userDataURL = fs.mkdtempSync(path.join(os.tmpdir(), "cua-test-"));
  mocks.daemonReady = false;
  mocks.autoReady = false;
  mocks.permissionGranted = false;
  mocks.deferPermissionHost = false;
  mocks.permissionCleanupGate = undefined;
  mocks.installGate = undefined;
  mocks.policyActive = true;
  mocks.policyPath = "";
  mocks.captureReady = true;
  mocks.captureVerificationError = false;
  mocks.callerAttribution = false;
  mocks.endpointProofValid = true;
  mocks.permissionGateAttempts = 0;
  mocks.gatewayOptions = undefined; mocks.windowItems = undefined; mocks.nativeForeground = false; mocks.windowProbeGate = undefined;
  mocks.windowProbeStarted.mockClear();
  mocks.beforeRawSocketError = undefined;
  mocks.rejectImplicitHostSession = false; mocks.hostRequests.length = 0; mocks.closedHostSessions.length = 0;
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
    expect(entry!.command).toBe("/bundled/node");
    expect(entry!.args).toEqual(["-e", "relay"]);
    expect(entry!.allowTools).toContain("click");
    expect(entry!.allowTools).not.toContain("check_for_update");
    expect(entry!.allowTools).not.toContain("replay_trajectory");
    expect(entry!.denyTools).toEqual(["check_for_update", "install_ffmpeg", "replay_trajectory"]);
    expect(entry!.env?.NUWAX_CUA_GATEWAY_TOKEN).toBe(endpointTokenFile());
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
  it("强杀遗留的自有 Unix socket 经确认无人监听后回收，下次启用成功", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const { socketPath } = await createEndpointSocket(true);
    mocks.autoReady = mocks.permissionGranted = true;
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("旧端点位置是普通文件时失败关闭，保留文件且不启动 helper", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const socketPath = (await getCuaStatus()).socketPath!;
    fs.writeFileSync(socketPath, "keep this file", { mode: 0o600 });
    mocks.autoReady = mocks.permissionGranted = true;
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("endpointSocketUntrusted");
    expect(fs.readFileSync(socketPath, "utf8")).toBe("keep this file");
    expect(mocks.spawnCalls.some(x => x.args.includes("serve"))).toBe(false);
  });

  it("活跃 socket 即使不能通过身份握手也不删除或替换", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const { socketPath, server } = await createEndpointSocket(false);
    const identity = fs.lstatSync(socketPath);
    mocks.autoReady = mocks.permissionGranted = true;
    try {
      const result = await setCuaEnabled(true);
      expect(result).toMatchObject({ success: false, error: "helperStillRunning" });
      expect(fs.lstatSync(socketPath).ino).toBe(identity.ino);
      expect(mocks.spawnCalls.some(x => x.args.includes("serve"))).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("探测期间端点被换成文件时保留替换物并拒绝启动", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const { socketPath } = await createEndpointSocket(true);
    mocks.beforeRawSocketError = () => {
      fs.unlinkSync(socketPath);
      fs.writeFileSync(socketPath, "replacement", { mode: 0o600 });
    };
    mocks.autoReady = mocks.permissionGranted = true;
    const result = await setCuaEnabled(true);
    expect(result).toMatchObject({ success: false, error: "endpointSocketUntrusted" });
    expect(fs.readFileSync(socketPath, "utf8")).toBe("replacement");
    expect(mocks.spawnCalls.some(x => x.args.includes("serve"))).toBe(false);
  });

  it("端点符号链接不跟随，也不删除其目标", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    const socketPath = (await getCuaStatus()).socketPath!;
    const target = path.join(mocks.userDataURL, "keep.txt");
    fs.writeFileSync(target, "keep");
    fs.symlinkSync(target, socketPath);
    mocks.autoReady = mocks.permissionGranted = true;
    const result = await setCuaEnabled(true);
    expect(result).toMatchObject({ success: false, error: "endpointSocketUntrusted" });
    expect(fs.lstatSync(socketPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });

  it("未设置开关时默认关闭，启动只清除旧 MCP 条目，不安装或启动 helper", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.settings.set("mcp_local_config", JSON.stringify({ mcpServers: {
      cua: { command: "old-helper", args: ["mcp"] },
      other: { command: "other-server", args: [] },
    } }));
    await ensureCuaOnBoot();
    expect(readMcpServers()).toEqual({ other: { command: "other-server", args: [] } });
    expect(fs.existsSync(stableHelperPath())).toBe(false);
    expect(mocks.spawnCalls).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
    expect((await getCuaStatus()).enabled).toBe(false);
  });

  it("persists ask-mode authorization and a software blacklist", async () => {
    expect((await getCuaStatus()).authMode).toBe("unrestricted");
    expect((await getCuaStatus()).blacklist).toEqual([]);
    expect((await getCuaStatus()).screenshotHome).toContain("computer-use");
    const auth = await setCuaAuthMode("ask");
    expect(auth.status.authMode).toBe("ask");
    const blocked = await setCuaBlacklist(["1Password", ""]);
    expect(blocked.status.blacklist).toEqual(["1Password"]);
  });

  it("agent cursor defaults on and can be turned off", async () => {
    expect((await getCuaStatus()).agentCursor).toBe(true);
    const off = await setCuaAgentCursorEnabled(false);
    expect(off.success).toBe(true);
    expect(off.status.agentCursor).toBe(false);
    expect((mocks.settings.get("step1_config") as Record<string, unknown>).computerUseAgentCursor).toBe(false);
    expect((await getCuaStatus()).agentCursor).toBe(false);
    const on = await setCuaAgentCursorEnabled(true);
    expect(on.status.agentCursor).toBe(true);
  });

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
    const kills = mocks.execCalls.filter(call => call.cmd === "pkill");
    expect(kills.length).toBeGreaterThan(0);
    // Fallbacks must terminate the daemon and never match a bare product name.
    expect(kills.every(call => call.args.includes("-KILL"))).toBe(true);
    expect(kills.every(call => call.args.some(arg => arg.startsWith("^") && arg.includes(" serve --socket ")))).toBe(true);
    const pattern = kills[kills.length - 1].args[kills[kills.length - 1].args.length - 1];
    const command = path.join(stableHelperPath(), "Contents", "MacOS", "Nuwax Computer Use") + " serve --socket /owned-endpoint";
    expect(new RegExp(pattern).test(command)).toBe(true);
    expect(new RegExp(pattern).test("node -e '" + command + "'")).toBe(false);
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
    expect(serve!.args).toContain("--no-permissions-gate");
    expect(serve!.args.some((arg) => arg.startsWith("CUA_DRIVER_MANAGED_POLICY_FILE="))).toBe(true);

    mocks.permissionGranted = false;
    const revoked = await getCuaStatus();
    expect(revoked.enabled).toBe(true);
    expect(revoked.running).toBe(false);
    expect(readMcpServers().cua).toBeUndefined();
  });

  it("enabled but daemon down does not report stale granted helper permissions", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    const enabled = await setCuaEnabled(true);
    expect(enabled).toMatchObject({ success: true, status: { accessibility: true, screenRecording: true, running: true } });
    mocks.daemonReady = false;
    const down = await getCuaStatus();
    expect(down).toMatchObject({
      enabled: true,
      running: false,
      accessibility: null,
      screenRecording: null,
      error: "daemonNotReady",
    });
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
    const reopened = await loadCua();
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

  it("权限已授予但助手身份无法确认时，报身份问题而不是让用户再去授权", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true;
    mocks.callerAttribution = true;
    mocks.autoReady = true;
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("helperIdentityUnverified");
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

  it("登录失效在启动队列等待期间同步撤销，并保留用户开关偏好", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.proxySync.mockImplementation(async (servers: Record<string, unknown>) => {
      if (servers.cua) { entered(); await blocked; }
    });
    const boot = ensureCuaOnBoot();
    await reached;
    const stopping = cuaModule.suspendCua("sessionEnded");
    expect(cuaModule.getCuaRuntime()).toMatchObject({ phase: "stopped", reason: "sessionEnded", controlPending: true });
    release();
    await Promise.all([boot, stopping]);
    expect(await getCuaStatus()).toMatchObject({ enabled: true, running: false, mcpInjected: false });
    expect(cuaModule.getCuaRuntime().controlPending).toBe(false);
  });

  it("恢复就绪的迟到结果不能覆盖更新的停止命令", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    mocks.permissionGranted = true;
    mocks.autoReady = true;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.proxySync.mockImplementation(async (servers: Record<string, unknown>) => {
      if (servers.cua) { entered(); await blocked; }
    });
    const recovering = cuaModule.recoverCua();
    await reached;
    const stopping = cuaModule.stopCuaTask();
    release();
    expect((await recovering).success).toBe(false);
    expect((await stopping).success).toBe(true);
    expect(cuaModule.getCuaRuntime()).toMatchObject({ phase: "stopped", reason: "userStopped" });
    expect(await getCuaStatus()).toMatchObject({ enabled: true, running: false, mcpInjected: false });
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

  it("启动收敛只做无提示探测，撤权时停止执行但保留用户偏好", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    mocks.autoReady = true;
    await ensureCuaOnBoot();
    expect((mocks.settings.get("step1_config") as Record<string, unknown>).computerUseEnabled).toBe(true);
    expect(readMcpServers().cua).toBeUndefined();
    expect(mocks.spawnCalls.some((c) => c.args.includes("__permissions-host-request"))).toBe(false);
    expect(mocks.spawnCalls.find(c => c.args.includes("serve"))?.args).toContain("--no-permissions-gate");
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

describe("live blacklist enforcement", () => {
  it("preserves the native discovery output contract while filtering denied windows", async () => {
    await setCuaEnabled(false);
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true; mocks.autoReady = true;
    expect((await setCuaEnabled(true)).success).toBe(true);
    const native = { pid: 25, window_id: 50, app_name: "Fixture", title: "Document",
      bounds: { x: 10, y: 20, width: 600, height: 400 }, is_on_screen: true, z_index: null,
      layer: 0, current_space_id: 1, on_current_space: true, space_ids: [1] };
    mocks.windowItems = [native,
      { ...native, pid: 26, window_id: 51, app_name: "Denied" },
      { ...native, pid: 27, window_id: 52, app_name: "SecurityAgent" }];
    await cuaModule.setCuaBlacklist(["Denied"]);
    // list_windows advertises the helper's strict WindowInfo output schema.
    // UI labels may be projected, but model discovery must retain the native row.
    expect(await mocks.gatewayOptions.discoverWindows()).toEqual([native]);
    expect(await cuaModule.listCuaWindows()).toEqual([{ pid: 25, windowId: 50, label: "Fixture — Document" }]);
  });
  it("checks trusted live PID metadata and refuses unresolved global/browser input", async () => {
    await setCuaEnabled(false);
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true; mocks.autoReady = true;
    await setCuaEnabled(true);
    await cuaModule.setCuaBlacklist(["Fixture"]);
    const check = mocks.gatewayOptions.rejectTarget;
    expect(await check("click", { pid: 25, window_id: 50, app_name: "Safe" })).toBe("blacklisted");
    expect(await check("get_window_state", { pid: 25, window_id: 50 })).toBe("blacklisted");
    expect(await check("get_desktop_state", {})).toBe("blacklisted");
    expect(await check("get_desktop_state", { pid: 999 })).toBe("blacklisted");
    expect(await check("click", { pid: 999, window_id: 999 })).toBe("targetClosed");
    expect(await check("browser_click", { target_id: "unbound", tab_id: "t", ref: "e1" })).toBe("scopeViolation");
    expect(await cuaModule.listCuaWindows()).toEqual([]);
    await cuaModule.setCuaBlacklist([]);
    mocks.windowItems = [{ pid: 25, window_id: 50, app_name: "SecurityAgent", title: "Allow" }];
    expect(await check("click", { pid: 25, window_id: 50 })).toBe("blacklisted");
    expect(await cuaModule.listCuaWindows()).toEqual([]);
  });
});

describe("upgrade preference ownership", () => {
  it("preserves an enabled preference when re-enabling fails during helper recovery", async () => {
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    const result = await setCuaEnabled(true);
    expect(result.success).toBe(false);
    expect(result.status.enabled).toBe(true);
    expect(result.status.mcpInjected).toBe(false);
  });

  it("revokes execution even when persisting explicit disable fails", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true; mocks.autoReady = true;
    expect((await setCuaEnabled(true)).success).toBe(true);
    mocks.settingFailure = true;
    const result = await setCuaEnabled(false);
    expect(result.success).toBe(false);
    expect(result.status).toMatchObject({ running: false, mcpInjected: false });
  });

  it("a stale general-settings snapshot cannot erase or resurrect the CU preference", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true; mocks.autoReady = true;
    expect((await setCuaEnabled(true)).success).toBe(true);
    mocks.settings.set("step1_config", { workspaceDir: "/changed", computerUseEnabled: false });
    expect((await getCuaStatus()).enabled).toBe(true);
    await setCuaEnabled(false);
    mocks.settings.set("step1_config", { computerUseEnabled: true });
    expect((await getCuaStatus()).enabled).toBe(false);
  });

});

describe("permission request ownership", () => {
  it("quit waits for standalone permission host cleanup after cancelling its polling", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.deferPermissionHost = true;
    let release!: () => void;
    mocks.permissionCleanupGate = new Promise(resolve => { release = resolve; });
    const request = cuaModule.requestCuaPermissions();
    const suspended = cuaModule.suspendCua("appQuit");
    try {
      await vi.waitFor(() => expect(mocks.execCalls.some(c => c.cmd === "pkill" && c.args.some(a => a.includes("__permissions-host-request")))).toBe(true));
      expect(await Promise.race([suspended.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))])).toBe(false);
    } finally { release(); await Promise.all([request, suspended]); }
  });
  it("does not launch a permission host when cancelled during helper installation", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    let release!: () => void;
    mocks.installGate = new Promise(resolve => { release = resolve; });
    const enabling = setCuaEnabled(true);
    await vi.waitFor(() => expect(mocks.execCalls.some(c => c.cmd === "codesign")).toBe(true));
    const disabling = setCuaEnabled(false);
    release();
    const [on, off] = await Promise.all([enabling, disabling]);
    expect(on).toMatchObject({ success: false, error: "disabledDuringEnable" });
    expect(off.status.enabled).toBe(false);
    expect(mocks.spawnCalls.some(c => c.args.includes("__permissions-host-request"))).toBe(false);
  });
  it("coalesces concurrent clicks and precisely cleans the cancelled host", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.deferPermissionHost = true;
    const first = cuaModule.requestCuaPermissions();
    const second = cuaModule.requestCuaPermissions();
    expect(first).toBe(second);
    const hosts = mocks.spawnCalls.filter(c => c.args.includes("__permissions-host-request"));
    expect(hosts).toHaveLength(1);
    const resultFile = hosts[0].args[hosts[0].args.indexOf("--result-file") + 1];
    expect(cuaModule.cancelCuaPermissionRequest()).toBe(true);
    expect(await first).toMatchObject({ success: false, error: "operationCancelled" });
    expect(fs.existsSync(resultFile)).toBe(false);
    const cleanup = mocks.execCalls.find(c => c.cmd === "pkill" && c.args.some(a => a.includes("__permissions-host-request")));
    expect(cleanup?.args).toEqual(["-KILL", "-f", expect.stringContaining(resultFile.replaceAll(".", "\\."))]);
    expect(cleanup?.args[2]).toContain("^" + stableHelperPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    expect((await getCuaStatus()).accessibility).toBeNull();
  });
  it("soft-timeout keeps watching a late helper result instead of discarding it", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.deferPermissionHost = true;
    vi.useFakeTimers();
    try {
      const request = cuaModule.requestCuaPermissions();
      const host = mocks.spawnCalls.find(c => c.args.includes("__permissions-host-request"))!;
      const resultFile = host.args[host.args.indexOf("--result-file") + 1];
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await request).toMatchObject({ success: false, error: "timeout" });
      fs.writeFileSync(resultFile, JSON.stringify({ structuredContent: { accessibility: true, screen_recording: true } }));
      await vi.advanceTimersByTimeAsync(1000);
      expect((await getCuaStatus()).accessibility).toBe(true);
      expect((await getCuaStatus()).screenRecording).toBe(true);
    } finally {
      cuaModule.cancelCuaPermissionRequest();
      vi.useRealTimers();
    }
  });

  it("enable timeout rollback keeps late permission results until explicit disable", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.deferPermissionHost = true;
    vi.useFakeTimers();
    try {
      const enabling = setCuaEnabled(true);
      await vi.advanceTimersByTimeAsync(1000);
      const host = mocks.spawnCalls.find(c => c.args.includes("__permissions-host-request"))!;
      expect(host).toBeDefined();
      const file = host.args[host.args.indexOf("--result-file") + 1];
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await enabling).toMatchObject({ success: false, error: "timeout" });
      expect(fs.existsSync(file)).toBe(true);
      fs.writeFileSync(file, JSON.stringify({ structuredContent: { accessibility: true, screen_recording: true } }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await getCuaStatus()).toMatchObject({ accessibility: true, screenRecording: true, enabled: false });
      await setCuaEnabled(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fs.existsSync(file)).toBe(false);
    } finally { cuaModule.cancelCuaPermissionRequest(); vi.useRealTimers(); }
  });

  it("user cancel after timeout still discards a late linger result", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.deferPermissionHost = true;
    vi.useFakeTimers();
    try {
      const request = cuaModule.requestCuaPermissions();
      const host = mocks.spawnCalls.find(c => c.args.includes("__permissions-host-request"))!;
      const resultFile = host.args[host.args.indexOf("--result-file") + 1];
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await request).toMatchObject({ success: false, error: "timeout" });
      expect(cuaModule.cancelCuaPermissionRequest()).toBe(true);
      fs.writeFileSync(resultFile, JSON.stringify({ structuredContent: { accessibility: true, screen_recording: true } }));
      await vi.advanceTimersByTimeAsync(1000);
      expect((await getCuaStatus()).accessibility).toBeNull();
    } finally {
      cuaModule.cancelCuaPermissionRequest();
      vi.useRealTimers();
    }
  });
  it("disable cancels an in-flight enable without waiting for the permission timeout", async () => {
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.deferPermissionHost = true;
    const enabling = setCuaEnabled(true);
    await vi.waitFor(() => expect(mocks.spawnCalls.some(c => c.args.includes("__permissions-host-request"))).toBe(true));
    const disabling = setCuaEnabled(false);
    const [on, off] = await Promise.all([enabling, disabling]);
    expect(on).toMatchObject({ success: false, error: "operationCancelled" });
    expect(off).toMatchObject({ success: true, status: { enabled: false, consentPending: false, mcpInjected: false } });
    expect(mocks.spawnCalls.some(c => c.args.includes("serve"))).toBe(false);
  });
  it("session invalidation revokes the outstanding host before lifecycle cleanup", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.deferPermissionHost = true;
    const request = cuaModule.requestCuaPermissions();
    const suspended = cuaModule.suspendCua("sessionEnded");
    expect(await request).toMatchObject({ success: false, error: "operationCancelled" });
    await suspended;
    expect((await getCuaStatus()).accessibility).toBeNull();
  });
  it("synchronously cancels an outstanding request before quit cleanup", async () => {
    makeHelperApp(path.dirname(stableHelperPath()));
    mocks.deferPermissionHost = true;
    const request = cuaModule.requestCuaPermissions();
    expect(cuaModule.cancelCuaPermissionRequest()).toBe(true);
    expect(await request).toMatchObject({ success: false, error: "operationCancelled" });
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

    const mod = await loadCua();
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

    const mod = await loadCua();
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

    const mod = await loadCua();
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
    expect(JSON.parse(policy).allow.tools).toContain("click");
    expect(JSON.parse(policy).deny.tools).toContain("check_for_update");
  });
});


describe("cua window selection lifecycle", () => {
  it("uses fresh EOF-owned host sessions after the native implicit session has ended", async () => {
    mocks.daemonReady = true;
    mocks.rejectImplicitHostSession = true;
    const expected = [{ pid: 25, windowId: 50, label: "Fixture — Document" }];
    expect(await cuaModule.listCuaWindows()).toEqual(expected);
    expect(await cuaModule.listCuaWindows()).toEqual(expected);
    const begins = mocks.hostRequests.filter(r => r.method === "session_begin");
    const calls = mocks.hostRequests.filter(r => r.method === "call");
    expect(begins).toHaveLength(2);
    expect(new Set(begins.map(r => r.session_id)).size).toBe(2);
    expect(calls.map(r => r.session_id)).toEqual(begins.map(r => r.session_id));
    expect(mocks.closedHostSessions).toEqual(begins.map(r => r.session_id));
  });
  it("validates a live target, persists only scope kind and rejects a failed preference write", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.resetModules(); cuaModule = await loadCua();
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true; mocks.autoReady = true;
    expect((await setCuaEnabled(true)).success).toBe(true);
    expect(await cuaModule.listCuaWindows()).toEqual([{ pid: 25, windowId: 50, label: "Fixture — Document" }]);
    expect((await cuaModule.setCuaScope({ kind: "window", pid: 25, windowId: 999 })).error).toBe("targetClosed");
    const result = await cuaModule.setCuaScope({ kind: "window", pid: 25, windowId: 50 });
    expect(result.success).toBe(true);
    expect(result.runtime.scope).toEqual({ kind: "window", pid: 25, windowId: 50, label: "Fixture — Document" });
    expect((mocks.settings.get("step1_config") as any).computerUseScopeKind).toBe("window");
    expect(JSON.stringify(mocks.settings.get("step1_config"))).not.toContain("Document");
    const policy = JSON.parse(fs.readFileSync(mocks.policyPath, "utf8"));
    expect(policy.allow.rules[0].constraints.window_id.allowed).toEqual([50]);
    mocks.settingFailure = true;
    expect((await cuaModule.setCuaScope({ kind: "desktop" })).error).toBe("scopeSaveFailed");
    expect(cuaModule.getCuaRuntime().scope?.kind).toBe("window");
    mocks.settingFailure = false; await setCuaEnabled(false);
  });
  it("migrates old window selection to host-validated agent binding without broadening native input", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.resetModules(); cuaModule = await loadCua();
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true; mocks.autoReady = true;
    mocks.settings.set("step1_config", { computerUseEnabled: true, computerUseScopeKind: "window" });
    await ensureCuaOnBoot();
    expect(cuaModule.getCuaRuntime().multiwindow).toBe(true);
    await expect(mocks.gatewayOptions.prepareTarget("A", "get_window_state", { pid: 25, window_id: 999 })).rejects.toThrow("targetClosed");
    await mocks.gatewayOptions.prepareTarget("A", "get_window_state", { pid: 25, window_id: 50 });
    const task = mocks.gatewayOptions.tasks.stateForOwner("A");
    expect(task.scope).toEqual({ kind: "window", pid: 25, windowId: 50, label: "Fixture — Document" });
    expect(task.phase).toBe("running");
    expect((await getCuaStatus()).enabled).toBe(true);
    await setCuaEnabled(false);
  });
});

describe("multiwindow native handoff lifecycle", () => {
  async function prepared() {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.resetModules(); cuaModule = await loadCua();
    makeHelperApp(path.join(process.resourcesPath as string, "computer-use"));
    mocks.permissionGranted = true; mocks.autoReady = true;
    expect((await setCuaEnabled(true)).success).toBe(true);
    expect((await cuaModule.setMultiwindowEnabled(true)).success).toBe(true);
    const registry = mocks.gatewayOptions.controller as import("./taskRegistry").CuaTaskRegistry;
    const task = registry.ensure("test-window-owner");
    expect((await cuaModule.bindWindowTask(task.id, { pid: 25, windowId: 50 })).success).toBe(true);
    return { registry, task };
  }
  it("reads large preview frames without observation credit and rejects a late frame after rebind or lock", async () => {
    const { registry, task } = await prepared();
    mocks.nativeRequests.length = 0;
    const before = cuaModule.getCuaTasks()[0];
    const frame = await cuaModule.captureCuaTaskPreview(task.id);
    expect(frame.status).toBe("ready");
    expect(frame.frame?.jpeg.length).toBe(100000);
    expect(cuaModule.getCuaTasks()[0].stepCount).toBe(before.stepCount);
    expect(cuaModule.getCuaTasks()[0].needsObservation).toBe(before.needsObservation);
    let release!: () => void;
    mocks.previewGate = new Promise<void>(r => { release = r; });
    const late = cuaModule.captureCuaTaskPreview(task.id);
    await vi.waitFor(() => expect(mocks.nativeRequests.filter(r => r.name === "preview").length).toBeGreaterThanOrEqual(2));
    registry.bind(task.id, { pid: 25, windowId: 50, label: "new" }); release();
    expect((await late).status).toBe("ended");
    mocks.previewGate = undefined;
    cuaModule.setCuaPreviewSuspended(true);
    expect(cuaModule.getCuaPreviewIdentity(task.id)).toBeNull();
    cuaModule.setCuaPreviewSuspended(false);
    expect(cuaModule.getCuaPreviewIdentity(task.id)).not.toBeNull();
    await cuaModule.suspendCua();
  });
  it("does not activate the target when native revoke cannot be confirmed", async () => {
    const { task } = await prepared();
    mocks.nativeRequests.length = 0; mocks.revokeOK = false;
    expect((await cuaModule.takeOverWindowTask(task.id)).success).toBe(false);
    expect(mocks.nativeRequests.some(r => r.name === "takeover")).toBe(false);
    expect(cuaModule.getCuaTasks()[0]).toMatchObject({ phase: "paused", controlPending: true });
    mocks.revokeOK = true;
    await cuaModule.suspendCua();
  });
  it("takes over only after native revoke/drain and leaves the task paused", async () => {
    const { task } = await prepared();
    mocks.nativeRequests.length = 0;
    const result = await cuaModule.takeOverWindowTask(task.id);
    expect(result.success).toBe(true);
    const commands = mocks.nativeRequests.map(r => r.name);
    expect(commands.indexOf("takeover")).toBeGreaterThan(commands.indexOf("revoke"));
    expect(cuaModule.getCuaTasks()[0]).toMatchObject({ phase: "paused", reason: "userTakingControl" });
    await cuaModule.suspendCua();
  });
  it("keeps an explicitly bound target paused and yields to the user's active window", async () => {
    const { task } = await prepared();
    expect(cuaModule.getCuaTasks()[0]).toMatchObject({ taskId: task.id, phase: "paused", mode: "background" });
    mocks.nativeForeground = true;
    expect((await cuaModule.resumeWindowTask(task.id)).error).toBe("userTakingControl");
    mocks.nativeForeground = false;
    expect((await cuaModule.resumeWindowTask(task.id)).success).toBe(true);
    await cuaModule.suspendCua();
  });
  it("rejects a late resume after another pause revokes its window epoch", async () => {
    const { task } = await prepared();
    let release!: () => void;
    mocks.windowProbeGate = new Promise<void>((resolve) => { release = resolve; });
    const resuming = cuaModule.resumeWindowTask(task.id);
    await vi.waitFor(() => expect(mocks.windowProbeStarted).toHaveBeenCalled());
    await cuaModule.pauseWindowTask(task.id); release();
    expect((await resuming).error).toBe("operationCancelled");
    expect(cuaModule.getCuaTasks()[0].phase).toBe("paused");
    await cuaModule.suspendCua();
  });
  it("releases leases only after global shutdown and recovers without reusing old targets", async () => {
    const { registry, task } = await prepared();
    await cuaModule.resumeWindowTask(task.id);
    await registry.acquire(task.owner); registry.pending(task.id, true);
    expect((await cuaModule.stopCuaTask()).success).toBe(true);
    expect(cuaModule.getCuaRuntime()).toMatchObject({ recoverable: true, controlPending: false });
    expect((await cuaModule.recoverCua()).success).toBe(true);
    expect(cuaModule.getCuaTasks()).toEqual([]);
    const next = registry.ensure("new-turn");
    registry.bind(next.id, { pid: 25, windowId: 50, label: "" }); registry.resumeTask(next.id);
    const release = await registry.acquire(next.owner); release();
    expect(cuaModule.getCuaRuntime().recoverable).toBe(false);
    await cuaModule.suspendCua();
  });
});

describe("Linux legacy target migration", () => {
  it("binds a fresh native target before replacing the zero-ID helper policy", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.resetModules(); cuaModule = await loadCua();
    const bundled = path.join(process.resourcesPath as string, "computer-use", "NuwaxComputerUse");
    fs.mkdirSync(path.dirname(bundled), { recursive: true }); fs.writeFileSync(bundled, "synthetic-linux-helper");
    mocks.autoReady = true;
    mocks.settings.set("step1_config", { computerUseEnabled: true, computerUseScopeKind: "window" });
    await ensureCuaOnBoot();
    expect((await getCuaStatus()).enabled).toBe(true);
    await mocks.gatewayOptions.prepareTarget("A", "get_window_state", { pid: 25, window_id: 50 });
    expect(cuaModule.getCuaRuntime().scope).toMatchObject({ kind: "window", windowId: 50 });
    const policy = JSON.parse(fs.readFileSync(mocks.policyPath, "utf8"));
    expect(policy.allow.rules[0].constraints.window_id.allowed).toEqual([50]);
    await setCuaEnabled(false);
  });
});
