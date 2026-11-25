/**
 * 单元测试: AcpEngine 会话建立阶段的恢复能力（session-setup-ha）
 *
 * 覆盖引擎侧接线：
 * - destroy() 只取消本引擎会话的待审批，不再波及其他引擎
 * - 引擎被重建后，销毁前发出的 session/load 续体不再登记会话
 * - initialize 握手超时按预算失败并杀掉进程
 * - chat()：load 与回退 new 都无响应时有界结束，返回结构化错误并熔断
 * - chat()：模型同步无响应时收掉进程并返回结构化错误
 * - 同一会话并发消息共享一次会话建立
 *
 * 链路本身的分支在 acpSessionRecovery.test.ts。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import { chatDispatchCoordinator } from "../../computer/chatDispatchCoordinator";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === "home" ? "/mock/home" : "/mock/appdata",
    ),
    getVersion: vi.fn(() => "0.0.0-test"),
    isPackaged: false,
  },
}));

const mockAppDataDir = path.join(
  os.tmpdir(),
  `nuwaclaw-acp-engine-recovery-test-${process.pid}`,
);

vi.mock("../../system/appPaths", () => ({
  getAppDataDir: () => mockAppDataDir,
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../memory", () => ({
  memoryService: {
    isInitialized: vi.fn(() => false),
    init: vi.fn().mockResolvedValue(undefined),
    ensureMemoryReadyForSession: vi.fn().mockResolvedValue(undefined),
    onSessionEnd: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../utils/processTree", () => ({
  killProcessTree: vi.fn(),
  killProcessTreeGraceful: vi.fn(),
}));

vi.mock("../../system/processRegistry", () => ({
  processRegistry: {
    unregister: vi.fn(),
  },
}));

vi.mock("@main/services/system/dependencies", () => ({
  getResourcesPath: vi.fn(() => "/mock/resources"),
  getAppEnv: vi.fn(() => ({ PATH: "/mock/path" })),
  getBundledGitBashPath: vi.fn(() => null),
}));

vi.mock("@main/services/system/binaryLocator", async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import("@main/services/system/binaryLocator")
    >();
  return {
    ...mod,
    getBundledGitBashPath: () => "",
  };
});

import { AcpEngine } from "./acpEngine";
import * as acpClient from "./acpClient";
import { killProcessTreeGraceful } from "../../utils/processTree";
import { sessionSetupRecoveryState } from "./acpSessionRecovery";
import { isEngineInitTimeoutMessage } from "./sessionSetupFailure";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hang(): Promise<never> {
  return new Promise<never>(() => {});
}

function mockProcess(pid: number) {
  return {
    pid,
    on: vi.fn(),
    stdout: { removeAllListeners: vi.fn() },
    stderr: { removeAllListeners: vi.fn() },
    stdin: { removeAllListeners: vi.fn() },
    removeAllListeners: vi.fn(),
    kill: vi.fn(),
  } as any;
}

function mockConnection(overrides: Record<string, unknown> = {}) {
  return {
    initialize: vi.fn().mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    }),
    newSession: vi.fn(hang),
    loadSession: vi.fn(hang),
    setSessionConfigOption: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    ...overrides,
  };
}

const ENGINE_CONFIG = {
  engine: "nuwaxcode",
  workspaceDir: "/tmp",
  mcpServers: {},
  model: "openai-compatible/qwen",
} as any;

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** 让 init() 不碰真实进程：每次 createAcpConnection 发一个新连接，便于观察重建次数 */
function stubSpawn(connectionFactory: () => Record<string, unknown>) {
  vi.spyOn(acpClient, "resolveAcpBinary").mockReturnValue({
    binPath: "nuwaxcode",
    binArgs: ["acp"],
    isNative: true,
  });
  const createAcpConnection = vi
    .spyOn(acpClient, "createAcpConnection")
    .mockImplementation(async () => {
      return {
        connection: connectionFactory(),
        process: mockProcess(12345 + createAcpConnection.mock.calls.length),
        isolatedHome: null,
        cleanup: vi.fn(),
      } as any;
    });
  vi.spyOn(acpClient, "loadAcpSdk").mockResolvedValue({
    PROTOCOL_VERSION: 1,
  } as any);
  return createAcpConnection;
}

describe("AcpEngine session setup recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionSetupRecoveryState.reset();
    chatDispatchCoordinator.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("destroy() 只取消本引擎会话的待审批，不再调用全局 destroy", async () => {
    const { approvalInterventionService } =
      await import("../../intervention/approvalInterventionService");
    const cancelSpy = vi.spyOn(
      approvalInterventionService,
      "cancelByAcpSession",
    );
    const globalDestroySpy = vi.spyOn(
      approvalInterventionService,
      "destroy",
    );
    const engine = new AcpEngine("nuwaxcode");
    (engine as any).config = { engine: "nuwaxcode", workspaceDir: "/tmp" };
    (engine as any).sessions.set("s1", {
      id: "s1",
      acpSessionId: "acp-s1",
      createdAt: Date.now(),
      status: "idle",
    });
    (engine as any).sessions.set("s2", {
      id: "s2",
      createdAt: Date.now(),
      status: "idle",
    });

    await engine.destroy();

    expect(globalDestroySpy).not.toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalledTimes(2);
    expect(cancelSpy).toHaveBeenCalledWith("acp-s1", "engine_destroyed");
    expect(cancelSpy).toHaveBeenCalledWith("s2", "engine_destroyed");
  });

  it("引擎被重建后，销毁前发出的 session/load 续体不再登记会话", async () => {
    const engine = new AcpEngine("nuwaxcode");
    (engine as any).config = {
      engine: "nuwaxcode",
      workspaceDir: "/tmp",
      mcpServers: {},
    };
    const deferred = createDeferred<{ configOptions: unknown[] }>();
    (engine as any).acpConnection = {
      loadSession: vi.fn(() => deferred.promise),
      cancel: vi.fn(),
    };

    const pending = (engine as any).loadAcpSession("ses_stale", {
      title: "proj",
      cwd: "/tmp/proj",
    });
    await engine.destroy();
    deferred.resolve({ configOptions: [] });

    await expect(pending).rejects.toThrow(
      "ACP engine recycled during session setup",
    );
    expect((engine as any).sessions.has("ses_stale")).toBe(false);
    expect((engine as any).pendingLoadSessionRegistration).toBe(false);
    expect((engine as any).suppressSessionReplayFor.size).toBe(0);
  });

  it("销毁会重置 newSession 的预登记标志，并递增代际号", async () => {
    const engine = new AcpEngine("nuwaxcode");
    (engine as any).config = { engine: "nuwaxcode", workspaceDir: "/tmp" };
    (engine as any).pendingNewSessionRegistration = true;
    (engine as any).pendingLoadSessionRegistration = true;
    const before = (engine as any).lifecycleEpoch;

    await engine.destroy();

    expect((engine as any).lifecycleEpoch).toBe(before + 1);
    expect((engine as any).pendingNewSessionRegistration).toBe(false);
    expect((engine as any).pendingLoadSessionRegistration).toBe(false);
  });

  it("initialize 握手无响应：按预算失败并杀掉进程", async () => {
    const connection = mockConnection({
      initialize: vi.fn(hang),
    });
    const createAcpConnection = stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");
    // 服务层在 init 前会挂 error 监听（forwardEvents）；EventEmitter 没有 error 监听时
    // emit("error") 会直接抛出，这里对齐真实接线
    const errors: unknown[] = [];
    engine.on("error", (err) => errors.push(err));

    vi.useFakeTimers();
    const pending = engine.init(ENGINE_CONFIG).then(
      (value) => value,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(createAcpConnection).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      error: "handshake timed out after 10000ms",
    });
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toBe(
      "handshake timed out after 10000ms",
    );
    expect(isEngineInitTimeoutMessage((result as { error: string }).error)).toBe(true);
    expect(killProcessTreeGraceful).toHaveBeenCalledWith(12346, 5000);
    expect(engine.isReady).toBe(false);
  });

  it("握手在预算内返回则正常就绪", async () => {
    const connection = mockConnection();
    stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");

    vi.useFakeTimers();
    const pending = engine.init(ENGINE_CONFIG);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.isReady).toBe(true);
    expect(killProcessTreeGraceful).not.toHaveBeenCalled();
  });

  it("load 与回退 new 都无响应：有界结束，返回结构化错误并熔断（同事日志场景）", async () => {
    const connections: Array<ReturnType<typeof mockConnection>> = [];
    const createAcpConnection = stubSpawn(() => {
      const connection = mockConnection();
      connections.push(connection);
      return connection;
    });
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    const request = {
      user_id: "u1",
      project_id: "1759004",
      session_id: "ses_df467f7a9ffeGcNJ3k1TjMfdKI",
      request_id: "rid-hang-1",
      prompt: "你好",
    } as any;

    vi.useFakeTimers();
    const chatStartedAt = Date.now();
    const pending = engine.chat(request, undefined, {
      chainStartedAtMs: chatStartedAt,
    });

    // 硬上限之前不做任何处置
    await vi.advanceTimersByTimeAsync(39_999);
    expect(createAcpConnection).toHaveBeenCalledTimes(1);
    expect(connections[0].loadSession).toHaveBeenCalledTimes(1);

    // load 硬超时 → 销毁并用原配置重启 → 回退 new（仍无响应）
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(killProcessTreeGraceful).toHaveBeenCalledTimes(1);
    expect(createAcpConnection).toHaveBeenCalledTimes(2);
    expect(connections[1].newSession).toHaveBeenCalledTimes(1);

    // 新进程里也建不出 → 收掉进程、熔断、返回结构化错误
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;

    expect(Date.now() - chatStartedAt).toBeLessThan(150_000);
    expect(result.success).toBe(false);
    expect(result.code).toBe("5000");
    expect(result.data).toMatchObject({
      project_id: "1759004",
      session_id: "ses_df467f7a9ffeGcNJ3k1TjMfdKI",
      request_id: "rid-hang-1",
      fallback_reason: "engine_env_hang",
    });
    expect(result.message).toBe(result.data!.error);
    expect(killProcessTreeGraceful).toHaveBeenCalledTimes(2);
    expect(engine.isReady).toBe(false);
    expect(
      sessionSetupRecoveryState.getOpenBreaker("1759004", Date.now()),
    ).not.toBeNull();

    // 之后同会话的消息不会再发任何 RPC
    const again = await engine.chat({ ...request, request_id: "rid-hang-2" });
    expect(again.success).toBe(false);
    expect(connections[0].loadSession).toHaveBeenCalledTimes(1);
    expect(connections[1].newSession).toHaveBeenCalledTimes(1);
  });

  it("load 硬超时后新进程能建出会话：用新会话继续并带上 fallback_reason", async () => {
    const connections: Array<ReturnType<typeof mockConnection>> = [];
    const newSession = createDeferred<{ sessionId: string }>();
    let spawned = 0;
    stubSpawn(() => {
      spawned += 1;
      const connection = mockConnection(
        spawned === 1 ? {} : { newSession: vi.fn(() => newSession.promise) },
      );
      connections.push(connection);
      return connection;
    });
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    vi.spyOn(engine, "promptAsync").mockResolvedValue(undefined);

    vi.useFakeTimers();
    const pending = engine.chat({
      user_id: "u1",
      project_id: "p1",
      session_id: "ses_hung",
      request_id: "rid-recover",
      prompt: "hi",
    } as any);
    await vi.advanceTimersByTimeAsync(40_000);
    await flush();
    // load 硬超时后已重建进程，并改用 session/new
    expect(connections).toHaveLength(2);
    expect(connections[1].newSession).toHaveBeenCalledTimes(1);
    newSession.resolve({ sessionId: "ses_recovered" });
    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      session_id: "ses_recovered",
      is_new_session: true,
      fallback_reason: "load_timeout",
    });
    expect(engine.isReady).toBe(true);
    expect(
      sessionSetupRecoveryState.getOpenBreaker("p1", Date.now()),
    ).toBeNull();
    await engine.destroy();
  });

  it("模型同步无响应：收掉进程并返回结构化错误", async () => {
    const connection = mockConnection({
      setSessionConfigOption: vi.fn(hang),
    });
    stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init({ ...ENGINE_CONFIG, model: "deepseek-flash" });
    (engine as any).sessions.set("acp-session-1", {
      id: "acp-session-1",
      acpSessionId: "acp-session-1",
      projectId: "p-sync",
      createdAt: Date.now(),
      status: "idle",
    });
    const promptAsync = vi.spyOn(engine, "promptAsync").mockResolvedValue(undefined);

    vi.useFakeTimers();
    const pending = engine.chat({
      user_id: "u1",
      project_id: "p-sync",
      session_id: "acp-session-1",
      request_id: "rid-sync",
      prompt: "hi",
    } as any);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(connection.setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ fallback_reason: "setup_timeout" });
    expect(promptAsync).not.toHaveBeenCalled();
    expect(killProcessTreeGraceful).toHaveBeenCalledTimes(1);
    expect(engine.isReady).toBe(false);
  });

  it("同一会话的并发消息共享一次会话建立", async () => {
    const connection = mockConnection();
    const deferred = createDeferred<{ configOptions: unknown[] }>();
    connection.loadSession = vi.fn(() => deferred.promise);
    stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    vi.spyOn(engine, "promptAsync").mockResolvedValue(undefined);
    const request = {
      user_id: "u1",
      project_id: "p1",
      session_id: "ses_shared",
      prompt: "hi",
    } as any;

    const first = engine.chat({ ...request, request_id: "rid-a" });
    const second = engine.chat({ ...request, request_id: "rid-b" });
    await flush();
    expect(connection.loadSession).toHaveBeenCalledTimes(1);

    deferred.resolve({ configOptions: [] });
    const [a, b] = await Promise.all([first, second]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.data!.session_id).toBe("ses_shared");
    expect(b.data!.session_id).toBe("ses_shared");
    expect(connection.newSession).not.toHaveBeenCalled();
    await engine.destroy();
  });

  it("recycleForRecovery 不 respawn 时引擎保持已销毁，不复活", async () => {
    const connection = mockConnection();
    const createAcpConnection = stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);

    const result = await engine.recycleForRecovery("give_up", {
      respawn: false,
    });

    expect(result).toEqual({ ok: true });
    expect(engine.isReady).toBe(false);
    expect(createAcpConnection).toHaveBeenCalledTimes(1);
  });
});
