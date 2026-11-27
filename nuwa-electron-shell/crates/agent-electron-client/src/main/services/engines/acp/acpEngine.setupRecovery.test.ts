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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import log from "electron-log";
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

import {
  AcpEngine,
  registerActiveIsolatedHomesProvider,
} from "./acpEngine";
import * as acpClient from "./acpClient";
import { killProcessTreeGraceful } from "../../utils/processTree";
import { sessionSetupRecoveryState } from "./acpSessionRecovery";
import {
  clearSessionSetupDiagnosticsForTests,
  getSessionSetupDiagnostics,
} from "./sessionSetupDiagnostics";
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
function stubSpawn(
  connectionFactory: () => Record<string, unknown>,
  isolatedHome: string | null = null,
) {
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
        isolatedHome,
        cleanup: vi.fn(),
      } as any;
    });
  vi.spyOn(acpClient, "loadAcpSdk").mockResolvedValue({
    PROTOCOL_VERSION: 1,
  } as any);
  return createAcpConnection;
}

/** 在（测试用的）应用数据目录下造一个持久化 project home：run/projects/u1/<id>/nuwaxcode/home */
function makePersistentHome(projectId = "p1"): string {
  const home = path.join(
    mockAppDataDir,
    "run",
    "projects",
    "u1",
    projectId,
    "nuwaxcode",
    "home",
  );
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function quarantineBackups(home: string): string[] {
  try {
    return fs
      .readdirSync(path.dirname(home))
      .filter((name) => name.startsWith("home.quarantine-"));
  } catch {
    return [];
  }
}

function seedSessionDb(home: string): string {
  const db = path.join(home, ".local", "share", "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, "old session data");
  return db;
}

describe("AcpEngine session setup recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionSetupRecoveryState.reset();
    clearSessionSetupDiagnosticsForTests();
    chatDispatchCoordinator.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    registerActiveIsolatedHomesProvider(null);
    delete process.env.NUWAX_SESSION_SETUP_AUTO_QUARANTINE;
    fs.rmSync(mockAppDataDir, { recursive: true, force: true });
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

  it("已跳过插件时握手仍无响应：按预算失败并杀掉进程", async () => {
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
    const pending = engine.init({ ...ENGINE_CONFIG, env: { OPENCODE_PURE: "1" } }).then(
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

  it("根目录插件卡住握手时重启为无插件模式", async () => {
    let spawned = 0;
    const spawn = stubSpawn(() => {
      spawned++;
      return mockConnection(spawned === 1 ? { initialize: vi.fn(hang) } : {});
    });
    const engine = new AcpEngine("nuwaxcode");
    engine.on("error", vi.fn());
    vi.useFakeTimers();
    const pending = engine.init(ENGINE_CONFIG);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0].env).toMatchObject({ OPENCODE_PURE: "1" });
    expect((engine as any).externalPluginsDisabledForRecovery).toBe(true);
    await engine.destroy();
  });

  it("跳过插件后握手仍超时，只重试一次并报告失败", async () => {
    const spawn = stubSpawn(() => mockConnection({ initialize: vi.fn(hang) }));
    const engine = new AcpEngine("nuwaxcode");
    const errors = vi.fn();
    engine.on("error", errors);
    vi.useFakeTimers();
    const pending = engine.init(ENGINE_CONFIG);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({ ok: false, error: "handshake timed out after 10000ms" });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledTimes(1);
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

  it("load 与跳过外部插件后的 load 都无响应：有界结束并熔断", async () => {
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

    // load 硬超时 → 跳过外部插件重启 → 再次恢复原会话
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(killProcessTreeGraceful).toHaveBeenCalledTimes(1);
    expect(createAcpConnection).toHaveBeenCalledTimes(2);
    expect(connections[1].loadSession).toHaveBeenCalledTimes(1);

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
    expect(connections[1].loadSession).toHaveBeenCalledTimes(1);
  });

  it("load 超时后跳过外部插件恢复原会话", async () => {
    const connections: Array<ReturnType<typeof mockConnection>> = [];
    const loadedSession = createDeferred<{ configOptions: unknown[] }>();
    let spawned = 0;
    stubSpawn(() => {
      spawned += 1;
      const connection = mockConnection(
        spawned === 1 ? {} : { loadSession: vi.fn(() => loadedSession.promise) },
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
    // load 硬超时后重建进程，再恢复原会话
    expect(connections).toHaveLength(2);
    expect(connections[1].loadSession).toHaveBeenCalledTimes(1);
    loadedSession.resolve({ configOptions: [] });
    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      session_id: "ses_hung",
      is_new_session: false,
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

  it.each(["continue", "reject"])("无外部插件模式必须明确确认：%s", async (choice) => {
    const connection = mockConnection();
    const spawn = stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    await engine.recycleForRecovery("external_plugins_disabled", {
      respawn: true,
      withoutExternalPlugins: true,
    });
    expect(spawn.mock.calls[1][0].env).toMatchObject({ OPENCODE_PURE: "1" });
    const id = "ses_existing";
    (engine as any).sessions.set(id, { id, acpSessionId: id, createdAt: Date.now(), status: "idle" });
    (engine as any).setEffectiveMode(id, "yolo");
    const progress = vi.fn();
    const end = vi.fn();
    engine.on("computer:progress", progress);
    engine.on("computer:promptEnd", end);
    const pending = engine.prompt(id, [{ type: "text", text: "hello" }]);
    await flush();
    const confirmation = progress.mock.calls.map(([event]) => event).find((event) => event.subType === "request_permission");
    expect(confirmation).toBeDefined();
    expect(connection.prompt).not.toHaveBeenCalled();
    const request = confirmation.data.request_permission_request;
    expect(request.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ optionId: "continue", kind: "allow_once" }),
      expect.objectContaining({ optionId: "reject", kind: "reject_once" }),
    ]));
    const resolved = engine.resolvePermissionIntervention({
      permission_resolve_request: {
        request_permission_response: { outcome: { Selected: { option_id: choice } } },
        session_id: id,
        tool_call_id: request.toolCall.toolCallId,
        save_rule: false,
      },
    });
    expect(resolved.ok).toBe(true);
    await pending;
    expect(connection.prompt).toHaveBeenCalledTimes(choice === "continue" ? 1 : 0);
    if (choice === "reject") expect(end).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    if (choice === "continue") {
      const next = engine.prompt(id, [{ type: "text", text: "another message" }]);
      await flush();
      expect(connection.prompt).toHaveBeenCalledTimes(1);
      const confirmations = progress.mock.calls.map(([event]) => event).filter((event) => event.subType === "request_permission");
      expect(confirmations).toHaveLength(2);
      const nextRequest = confirmations[1].data.request_permission_request;
      expect(engine.resolvePermissionIntervention({
        permission_resolve_request: {
          request_permission_response: { outcome: { Selected: { option_id: "reject" } } },
          session_id: id, tool_call_id: nextRequest.toolCall.toolCallId, save_rule: false,
        },
      }).ok).toBe(true);
      await next;
      expect(connection.prompt).toHaveBeenCalledTimes(1);
    }
    await engine.destroy();
  });

  it("原会话恢复后先返回 chat 响应，再等待用户确认发送原消息", async () => {
    const connections: Array<ReturnType<typeof mockConnection>> = [];
    const spawn = stubSpawn(() => {
      const connection = mockConnection(connections.length ? {
        loadSession: vi.fn().mockResolvedValue({ configOptions: [] }),
      } : {});
      connections.push(connection);
      return connection;
    });
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    const progress = vi.fn();
    engine.on("computer:progress", progress);
    vi.useFakeTimers();
    const pending = engine.chat({
      user_id: "u1", project_id: "p1", session_id: "ses_old", request_id: "rid-approval", prompt: "hello",
    } as any);
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ session_id: "ses_old", is_new_session: false });
    expect(spawn.mock.calls[1][0].env).toMatchObject({ OPENCODE_PURE: "1" });
    expect(connections[1].prompt).not.toHaveBeenCalled();
    const confirmation = progress.mock.calls.map(([event]) => event).find((event) => event.subType === "request_permission");
    expect(confirmation).toBeDefined();
    const request = confirmation.data.request_permission_request;
    expect(engine.resolvePermissionIntervention({
      permission_resolve_request: {
        request_permission_response: { outcome: { Selected: { option_id: "continue" } } },
        session_id: "ses_old", tool_call_id: request.toolCall.toolCallId, save_rule: false,
      },
    }).ok).toBe(true);
    await flush();
    expect(connections[1].prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_old" }));
    await engine.destroy();
  });

  it("恢复确认超时后不发送消息", async () => {
    const connection = mockConnection();
    stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    (engine as any).externalPluginsDisabledForRecovery = true;
    const id = "ses_timeout";
    (engine as any).sessions.set(id, { id, acpSessionId: id, createdAt: Date.now(), status: "idle" });
    const end = vi.fn();
    engine.on("computer:promptEnd", end);
    vi.useFakeTimers();
    const pending = engine.prompt(id, [{ type: "text", text: "hello" }]);
    await flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await pending;
    expect(connection.prompt).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    await engine.destroy();
  });

  it("等待确认时取消消息，迟到的确认不能发送消息", async () => {
    const connection = mockConnection();
    stubSpawn(() => connection);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    (engine as any).externalPluginsDisabledForRecovery = true;
    const id = "ses_cancel";
    (engine as any).sessions.set(id, { id, acpSessionId: id, createdAt: Date.now(), status: "idle" });
    const progress = vi.fn();
    engine.on("computer:progress", progress);
    const pending = engine.prompt(id, [{ type: "text", text: "hello" }]);
    await flush();
    const confirmation = progress.mock.calls.map(([event]) => event).find((event) => event.subType === "request_permission");
    const request = confirmation.data.request_permission_request;
    await engine.abortSession(id);
    await pending;
    const late = engine.resolvePermissionIntervention({
      permission_resolve_request: {
        request_permission_response: { outcome: { Selected: { option_id: "continue" } } },
        session_id: id,
        tool_call_id: request.toolCall.toolCallId,
        save_rule: false,
      },
    });
    expect(late.ok).toBe(false);
    expect(connection.prompt).not.toHaveBeenCalled();
    await engine.destroy();
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

describe("AcpEngine session setup recovery · 隔离 home 与诊断", () => {
  /** 连接全部无响应；freshFrom 起的新建会话恢复正常 */
  function stubHangingSpawn(home: string | null, freshFrom = Infinity) {
    const connections: Array<ReturnType<typeof mockConnection>> = [];
    let spawned = 0;
    const createAcpConnection = stubSpawn(() => {
      spawned += 1;
      const connection = mockConnection(
        spawned >= freshFrom
          ? { newSession: vi.fn().mockResolvedValue({ sessionId: "ses_fresh" }) }
          : {},
      );
      connections.push(connection);
      return connection;
    }, home);
    return { connections, createAcpConnection, spawnedCount: () => spawned };
  }

  const newChatRequest = (requestId: string) =>
    ({
      user_id: "u1",
      project_id: "p1",
      request_id: requestId,
      prompt: "hi",
    }) as any;

  /** 跑完「new 超时 → 重建 → new 再超时」两轮，停在隔离判定之前 */
  async function runUntilSecondNewTimeout() {
    await vi.advanceTimersByTimeAsync(40_000);
    await flush();
    await vi.advanceTimersByTimeAsync(40_000);
    await flush();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sessionSetupRecoveryState.reset();
    clearSessionSetupDiagnosticsForTests();
    registerActiveIsolatedHomesProvider(null);
    delete process.env.NUWAX_SESSION_SETUP_AUTO_QUARANTINE;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    registerActiveIsolatedHomesProvider(null);
    delete process.env.NUWAX_SESSION_SETUP_AUTO_QUARANTINE;
    fs.rmSync(mockAppDataDir, { recursive: true, force: true });
  });

  it("已禁用外部插件时仍可按原有隔离规则重建 home", async () => {
    const home = makePersistentHome();
    const db = seedSessionDb(home);
    const spawn = stubHangingSpawn(home, 3);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init({ ...ENGINE_CONFIG, env: { OPENCODE_PURE: "1" } });
    vi.spyOn(engine, "promptAsync").mockResolvedValue(undefined);

    vi.useFakeTimers();
    const pending = engine.chat(newChatRequest("rid-quarantine"));
    // 第一轮 new 超时：只重建进程，home 原样
    await vi.advanceTimersByTimeAsync(40_000);
    await flush();
    expect(spawn.spawnedCount()).toBe(2);
    expect(quarantineBackups(home)).toEqual([]);
    // 第二轮 new 超时：销毁 → 改名 → 重启 → 第三次 new 恢复正常
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;

    // 原数据整体挪进备份目录，新 home 是干净的
    const [backup] = quarantineBackups(home);
    expect(backup).toMatch(/^home\.quarantine-\d{14}$/);
    expect(
      fs.readFileSync(
        path.join(path.dirname(home), backup, ".local", "share", "opencode", "opencode.db"),
        "utf8",
      ),
    ).toBe("old session data");
    expect(fs.existsSync(db)).toBe(false);
    expect(spawn.spawnedCount()).toBe(3);
    expect(result).toMatchObject({
      success: true,
      data: {
        session_id: "ses_fresh",
        is_new_session: true,
        fallback_reason: "engine_env_reset",
      },
    });
    expect(sessionSetupRecoveryState.isHomeQuarantined(home)).toBe(true);
    expect(sessionSetupRecoveryState.getOpenBreaker("p1", Date.now())).toBeNull();
    await engine.destroy();
  });

  it("home 还被其他引擎共用时不隔离", async () => {
    const home = makePersistentHome();
    const db = seedSessionDb(home);
    const spawn = stubHangingSpawn(home);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    // 本引擎 + 同一 home 上的另一个引擎（常规项目多对话共用 home）
    registerActiveIsolatedHomesProvider(() => [home, home]);

    vi.useFakeTimers();
    const pending = engine.chat(newChatRequest("rid-shared"));
    await runUntilSecondNewTimeout();
    const result = await pending;

    expect(result.data).toMatchObject({ fallback_reason: "engine_env_hang" });
    expect(quarantineBackups(home)).toEqual([]);
    expect(fs.existsSync(db)).toBe(true);
    expect(spawn.spawnedCount()).toBe(2);
  });

  it("别的会话也建会话超时过（机器级变慢）时不隔离", async () => {
    const home = makePersistentHome();
    const db = seedSessionDb(home);
    const spawn = stubHangingSpawn(home);
    sessionSetupRecoveryState.noteSetupTimeout("other-project");
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);

    vi.useFakeTimers();
    const pending = engine.chat(newChatRequest("rid-slow-machine"));
    await runUntilSecondNewTimeout();
    const result = await pending;

    expect(result.data).toMatchObject({ fallback_reason: "engine_env_hang" });
    expect(quarantineBackups(home)).toEqual([]);
    expect(fs.existsSync(db)).toBe(true);
    expect(spawn.spawnedCount()).toBe(2);
  });

  it("用环境变量可以关掉自动隔离", async () => {
    process.env.NUWAX_SESSION_SETUP_AUTO_QUARANTINE = "0";
    const home = makePersistentHome();
    const db = seedSessionDb(home);
    const spawn = stubHangingSpawn(home, 3);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);

    vi.useFakeTimers();
    const pending = engine.chat(newChatRequest("rid-disabled"));
    await runUntilSecondNewTimeout();
    const result = await pending;

    expect(result.data).toMatchObject({ fallback_reason: "engine_env_hang" });
    expect(quarantineBackups(home)).toEqual([]);
    expect(fs.existsSync(db)).toBe(true);
    expect(spawn.spawnedCount()).toBe(2);
  });

  it.each(["claude-code", "codex-cli"])(
    "%s 的 home 可能存着登录态：不自动隔离",
    async (engineType) => {
      const home = makePersistentHome();
      const db = seedSessionDb(home);
      const spawn = stubHangingSpawn(home, 3);
      const engine = new AcpEngine(engineType);
      await engine.init({ ...ENGINE_CONFIG, engine: engineType });

      vi.useFakeTimers();
      const pending = engine.chat(newChatRequest(`rid-${engineType}`));
      await runUntilSecondNewTimeout();
      const result = await pending;

      expect(result.data).toMatchObject({ fallback_reason: "engine_env_hang" });
      expect(quarantineBackups(home)).toEqual([]);
      expect(fs.existsSync(db)).toBe(true);
      expect(spawn.spawnedCount()).toBe(2);
    },
  );

  it("每个 home 每次运行只隔离一次", async () => {
    const home = makePersistentHome();
    seedSessionDb(home);
    // 隔离之后的第三次仍无响应：不再隔离第二次，直接判环境卡死
    const spawn = stubHangingSpawn(home);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init({ ...ENGINE_CONFIG, env: { OPENCODE_PURE: "1" } });

    vi.useFakeTimers();
    const pending = engine.chat(newChatRequest("rid-once"));
    await runUntilSecondNewTimeout();
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;

    expect(result.data).toMatchObject({ fallback_reason: "engine_env_hang" });
    expect(quarantineBackups(home)).toHaveLength(1);
    expect(spawn.spawnedCount()).toBe(3);
  });

  it("判为卡死时把引擎日志尾部写进主日志和诊断缓冲", async () => {
    // 关掉自动隔离，让流程停在「新进程里仍建不出会话」的判定上
    process.env.NUWAX_SESSION_SETUP_AUTO_QUARANTINE = "0";
    const home = makePersistentHome();
    const engineLog = path.join(
      home,
      ".local",
      "share",
      "opencode",
      "log",
      "opencode.log",
    );
    fs.mkdirSync(path.dirname(engineLog), { recursive: true });
    fs.writeFileSync(
      engineLog,
      [
        'timestamp=2026-11-25T06:10:58.000Z level=INFO message="creating instance" directory=C:\\ws\\1759004',
        'timestamp=2026-11-25T06:10:58.001Z level=INFO message="bootstrapping" directory=C:\\ws\\1759004',
        'timestamp=2026-11-25T06:10:58.005Z level=INFO message="loading" api_key="sk-abcdefghijklmnop"',
      ].join("\n"),
    );
    stubHangingSpawn(home);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);

    vi.useFakeTimers();
    const pending = engine.chat(newChatRequest("rid-tail"));
    await runUntilSecondNewTimeout();
    const result = await pending;

    expect(result.data).toMatchObject({ fallback_reason: "engine_env_hang" });
    const tailCall = vi
      .mocked(log.warn)
      .mock.calls.find(([message]) =>
        String(message).includes("[SessionSetup] engine log tail"),
      );
    expect(tailCall).toBeDefined();
    expect(tailCall![1]).toEqual(
      expect.arrayContaining([expect.stringContaining("bootstrapping")]),
    );
    // 脱敏后才落日志
    expect(JSON.stringify(tailCall![1])).not.toContain("sk-abcdefghijklmnop");

    const { records } = getSessionSetupDiagnostics();
    expect(records.at(-1)).toMatchObject({
      ok: false,
      reason: "engine_env_hang",
      engineKey: "p1",
      recycled: ["external_plugins_disabled", "give_up"],
      breakerOpened: true,
      engineLogTail: expect.arrayContaining([
        expect.stringContaining("bootstrapping"),
      ]),
    });
  });

  it("恢复成功（重建过进程）同样留档，健康路径不留", async () => {
    const home = makePersistentHome();
    const spawn = stubHangingSpawn(home, 2);
    const engine = new AcpEngine("nuwaxcode");
    await engine.init(ENGINE_CONFIG);
    vi.spyOn(engine, "promptAsync").mockResolvedValue(undefined);

    vi.useFakeTimers();
    const pending = engine.chat(newChatRequest("rid-recovered"));
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await pending;
    expect(result.success).toBe(true);

    // 新会话已在内存里：第二次是健康路径
    const again = await engine.chat(newChatRequest("rid-healthy"));
    expect(again.success).toBe(true);

    const { records } = getSessionSetupDiagnostics();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ok: true,
      recycled: ["external_plugins_disabled"],
      quarantined: false,
      setupPath: "new→new_without_plugins",
    });
    await engine.destroy();
  });
});
