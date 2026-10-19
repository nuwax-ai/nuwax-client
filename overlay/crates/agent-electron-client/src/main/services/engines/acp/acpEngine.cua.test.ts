import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ACP_SESSION_CANCELLED_ERROR_CODE } from "@shared/constants";
import type { AcpChatHttpResult } from "@shared/types/computerTypes";
import * as dependencies from "@main/services/system/dependencies";
import * as sandboxPolicy from "@main/services/sandbox/policy";
import * as opencodeAcpSandbox from "./sandbox/opencodeAcpSandbox";
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
  `nuwaclaw-acp-engine-test-${process.pid}`,
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

vi.mock("@main/services/packages/guiAgentServer", () => ({
  getGuiAgentServerUrl: vi.fn(() => null),
}));

vi.mock("@main/services/packages/windowsMcp", () => ({
  getWindowsMcpUrl: vi.fn(() => null),
}));

vi.mock("@main/services/system/dependencies", () => ({
  getResourcesPath: vi.fn(() => "/mock/resources"),
  getAppEnv: vi.fn(() => ({ PATH: "/mock/path" })),
  getBundledGitBashPath: vi.fn(() => null),
}));

const mockGetBundledGitBashPath = vi.fn(() => "");

vi.mock("@main/services/system/binaryLocator", async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import("@main/services/system/binaryLocator")
    >();
  return {
    ...mod,
    getBundledGitBashPath: () => mockGetBundledGitBashPath(),
  };
});

vi.mock("@main/services/sandbox/policy", () => ({
  getSandboxPolicy: vi.fn(() => ({
    enabled: false,
    backend: "auto",
    mode: "compat",
    autoFallback: "startup-only",
    windowsMode: "workspace-write",
  })),
  resolveSandboxType: vi.fn(async () => ({
    type: "none",
    degraded: false,
  })),
  getBundledLinuxBwrapPath: vi.fn(() => null),
  getBundledWindowsSandboxHelperPath: vi.fn(() => null),
}));

import { AcpEngine } from "./acpEngine";
import * as acpClient from "./acpClient";
import * as acpChatMemory from "./acpChatMemory";

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

function setupEngine(engineType: "claude-code" | "nuwaxcode" = "nuwaxcode") {
  const engine = new AcpEngine(engineType);
  const sessionId = "session-test-001";
  const session = {
    id: sessionId,
    acpSessionId: sessionId,
    createdAt: Date.now(),
    status: "active",
  } as any;

  (engine as any).config = { engine: engineType, workspaceDir: "/tmp" } as any;
  (engine as any).acpConnection = {
    cancel: vi.fn(),
    prompt: vi.fn(),
  } as any;
  (engine as any).sessions.set(sessionId, session);

  return {
    engine,
    sessionId,
    session,
    acpConnection: (engine as any).acpConnection as {
      cancel: any;
      prompt: any;
    },
  };
}

function setupEngineForCreateSession(
  engineType: "claude-code" | "nuwaxcode" = "nuwaxcode",
) {
  const engine = new AcpEngine(engineType);
  const newSession = vi.fn().mockResolvedValue({ sessionId: "acp-session-1" });

  (engine as any).config = {
    engine: engineType,
    workspaceDir: "/workspace/project",
    mcpServers: {
      "gui-agent": {
        url: "http://127.0.0.1:9876/mcp",
        type: "http",
      },
      "safe-tool": {
        command: "node",
        args: ["tool.js"],
      },
    },
  } as any;
  (engine as any).acpConnection = {
    newSession,
    prompt: vi.fn(),
    cancel: vi.fn(),
  } as any;

  return { engine, newSession };
}


import {
  registerDesktopAgentSessionParticipant,
} from "../../../features";

/**
 * 引擎只经组合对象驱动参与者；凭据语义本身由特性内 sessionAuthority 测试覆盖。
 * 本测试用记录式假参与者锁定引擎的调用时序与参数。
 */
function createFakeParticipant() {
  const calls: string[] = [];
  const active = new Set<string>();
  const bound = new Map<string, string>();
  let seq = 0;
  const participant = {
    prepare(servers: Array<{ name: string; args?: string[]; env?: Array<{ name: string; value: string }> }>) {
      calls.push("prepare");
      const index = servers.findIndex((server) => server.name === "cua");
      if (index < 0) return { bind: (id: string) => calls.push(`bind:${id}`), cancel: () => calls.push("cancel") };
      const secret = `secret-${++seq}`;
      servers[index] = { name: "cua", command: "node", args: ["relay"], env: [{ name: "CAP", value: secret }] };
      return {
        bind: (id: string) => {
          calls.push(`bind:${id}:${secret}`);
          bound.set(id, secret); // 未 start 前凭据未激活，与真实签发语义一致
        },
        cancel: () => calls.push(`cancel:${secret}`),
      };
    },
    start(id: string) {
      calls.push(`start:${id}`);
      for (const secret of active) active.delete(secret); // 轮换：旧凭据失效
      const secret = bound.get(id);
      if (secret) active.add(secret);
      return seq;
    },
    finish(id: string, turn: number, cancelled: boolean) {
      calls.push(`finish:${id}:${turn}:${cancelled}`);
      const secret = bound.get(id);
      if (secret) active.delete(secret);
    },
    cancel(id: string) {
      calls.push(`cancel:${id}`);
      const secret = bound.get(id);
      if (secret) active.delete(secret);
    },
    remove(id: string) {
      calls.push(`remove:${id}`);
      const secret = bound.get(id);
      if (secret) { active.delete(secret); bound.delete(id); }
    },
    destroy() {
      calls.push("destroy");
      active.clear(); bound.clear();
    },
  };
  return { calls, active, bound, participant };
}

describe("AcpEngine Computer Use lifecycle wiring", () => {
  let fake: ReturnType<typeof createFakeParticipant>;
  let unregister: () => void;
  beforeEach(() => {
    fake = createFakeParticipant();
    unregister = registerDesktopAgentSessionParticipant("computer-use", () => fake.participant);
  });
  afterEach(() => unregister());
  function bind(_engine: AcpEngine, id: string) {
    const servers = [{ name: "cua", env: [] as Array<{ name: string; value: string }> }];
    fake.participant.prepare(servers).bind(id);
    return servers[0].env[0].value;
  }
  it("creates different session credentials through actual ACP newSession parameters", async () => {
    const { engine, newSession } = setupEngineForCreateSession();
    (engine as any).config.mcpServers = { cua: { command: "old-helper", args: [] } };
    newSession.mockResolvedValueOnce({ sessionId: "a" }).mockResolvedValueOnce({ sessionId: "b" });
    await engine.createSession(); await engine.createSession();
    const first = newSession.mock.calls[0][0].mcpServers.find((s: any) => s.name === "cua");
    const second = newSession.mock.calls[1][0].mcpServers.find((s: any) => s.name === "cua");
    expect(first.args).toEqual(["relay"]);
    expect(first.env[0].value).not.toBe(second.env[0].value);
    // 签发即绑定、未 start 不激活：与真实凭据语义一致
    expect(fake.active.size).toBe(0);
    expect(fake.bound.get("a")).toBe(first.env[0].value);
    expect(fake.bound.get("b")).toBe(second.env[0].value);
    await engine.destroy();
    expect(fake.calls.at(-1)).toBe("destroy");
    expect(fake.bound.size).toBe(0);
  });
  it.each(["resumeAcpSession", "loadAcpSession"] as const)("rotates credentials through %s", async (method) => {
    const { engine } = setupEngineForCreateSession();
    (engine as any).config.mcpServers = { cua: { command: "old-helper", args: [] } };
    const rpc = vi.fn().mockResolvedValue({});
    (engine as any).acpConnection[method === "resumeAcpSession" ? "resumeSession" : "loadSession"] = rpc;
    const old = bind(engine, "same");
    (engine as any).agentSessions.start("same");
    await engine[method]("same");
    // 重连后旧凭据失效、只剩会话当前一份
    expect(fake.bound.get("same")).not.toBe(old);
    expect(rpc.mock.calls[0][0].mcpServers[0].args).toEqual(["relay"]);
    expect([...fake.bound.keys()]).toEqual(["same"]);
    await engine.destroy();
  });
  it("allows only the active prompt and revokes before awaiting ACP cancellation", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const secret = bind(engine, sessionId), reply = createDeferred<any>(), cancelled = createDeferred<void>();
    acpConnection.prompt.mockReturnValue(reply.promise); acpConnection.cancel.mockReturnValue(cancelled.promise);
    const prompting = engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    expect(fake.active.has(secret)).toBe(true);
    const aborting = engine.abortSession(sessionId);
    // 撤销先于等待 ACP 取消完成：调用 abort 同步即失效
    expect(fake.active.has(secret)).toBe(false);
    cancelled.resolve(); reply.resolve({ stopReason: "end_turn" });
    await aborting; await prompting; await engine.destroy();
    expect(fake.bound.size).toBe(0);
  });
  it("never retries an uncertain prompt when desktop capabilities are attached", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const secret = bind(engine, sessionId);
    vi.spyOn(engine as any, "isMcpReconnectFailure").mockReturnValue(true);
    acpConnection.prompt.mockRejectedValue(new Error("MCP connection lost"));
    await engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    expect(acpConnection.prompt).toHaveBeenCalledTimes(1);
    expect(fake.active.has(secret)).toBe(false);
    await engine.destroy();
  });
  it("revokes before engine destruction waits for ACP and clears late prompt results", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const secret = bind(engine, sessionId), reply = createDeferred<any>(), cancelled = createDeferred<void>();
    acpConnection.prompt.mockReturnValue(reply.promise); acpConnection.cancel.mockReturnValue(cancelled.promise);
    const prompting = engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    const destroying = engine.destroy();
    // destroy 同步撤销参与者凭据，之后才等待 ACP
    expect(fake.calls).toContain("destroy");
    expect(fake.active.has(secret)).toBe(false);
    cancelled.resolve(); reply.resolve({ stopReason: "end_turn" });
    await destroying; await prompting;
    expect(fake.active.has(secret)).toBe(false);
  });
});

describe("NW-050 ACP SDK NDJSON error boundary", () => {
  afterEach(() => {
    unregisterEventForwarders();
    closeAndClearAllSseClients();
    agentService.removeAllListeners();
  });

  it.each(["HTTP 400", "JSON HTTP 400", "unrelated metadata", "max_tokens", "refusal", "end_turn", "cancelled"])(
    "preserves the terminal outcome for %s over the actual SDK transport",
    async (outcome) => {
      const sdk = await import("@agentclientprotocol/sdk");
      const { engine, sessionId } = setupEngine();
      const outbound = new TransformStream<Uint8Array>();
      const receivedFrames: any[] = [];
      const inbound = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          receivedFrames.push(JSON.parse(new TextDecoder().decode(chunk)));
          controller.enqueue(chunk);
        },
      });
      const remotePrompt = vi.fn(async () => {
        if (outcome === "HTTP 400") throw new Error("HTTP 400: context length exceeded");
        if (outcome === "JSON HTTP 400") throw new Error(JSON.stringify({ statusCode: 400, message: "context length exceeded" }));
        if (outcome === "unrelated metadata") throw new Error(JSON.stringify({
          message: "transport unavailable", previousRequest: "HTTP 400",
        }));
        return { stopReason: outcome };
      });
      const remote = new sdk.AgentSideConnection(
        () => ({ prompt: remotePrompt }) as unknown as import("@agentclientprotocol/sdk").Agent,
        sdk.ndJsonStream(inbound.writable, outbound.readable),
      );
      const client = new sdk.ClientSideConnection(
        () => ({ sessionUpdate: vi.fn(), requestPermission: vi.fn() }),
        sdk.ndJsonStream(outbound.writable, inbound.readable),
      );
      const terminal = vi.fn();
      engine.on("computer:promptEnd", terminal);
      (engine as any).acpConnection = client;
      vi.spyOn(engine as any, "isMcpReconnectFailure").mockReturnValue(true);
      const expectedSdkError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await engine.prompt(sessionId, [{ type: "text", text: "protocol fixture" }]);
        const reason = outcome === "unrelated metadata"
          ? "mcp_reconnecting"
          : ["end_turn", "cancelled"].includes(outcome) ? outcome : "error";
        expect(terminal).toHaveBeenCalledTimes(1);
        expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ reason }));
        expect(remotePrompt).toHaveBeenCalledTimes(outcome === "unrelated metadata" ? 2 : 1);
        if (outcome.includes("HTTP 400")) {
          // Generic agent errors become JSON-RPC Internal error; the original
          // diagnostic is carried in data.details by the installed ACP SDK.
          expect(receivedFrames[0].error).toMatchObject({
            code: -32603, message: "Internal error",
            data: outcome === "HTTP 400"
              ? { details: "HTTP 400: context length exceeded" }
              : { statusCode: 400, message: "context length exceeded" },
          });
          expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
            description: expect.stringContaining("HTTP 400: context length exceeded"),
          }));
        }
      } finally {
        expectedSdkError.mockRestore();
        await Promise.all([outbound.writable.getWriter().close(), inbound.writable.getWriter().close()]);
        await Promise.all([client.closed, remote.closed]);
      }
    },
  );
});

describe("NW-050 terminal errors through the client SSE pipeline", () => {
  afterEach(() => {
    unregisterEventForwarders();
    closeAndClearAllSseClients();
    agentService.removeAllListeners();
    vi.useRealTimers();
  });

  it.each(["HTTP 400", "max_tokens", "refusal", "streamed error", "end_turn", "cancelled"])(
    "writes the terminal %s frame before closing the stream",
    async (outcome) => {
      const { engine, sessionId, acpConnection } = setupEngine();
      const frames: string[] = [];
      const sentAtClose: string[][] = [];
      const response = {
        write: vi.fn((frame: string) => { frames.push(frame); return true; }),
        end: vi.fn(() => sentAtClose.push([...frames])),
      };
      const send = vi.fn();
      registerEventForwarders({
        getMainWindow: () => ({ webContents: { send } }),
      } as unknown as HandlerContext);
      attachEngineEventForwarders(engine, Object.assign(agentService, {
        assistantTextBuffers: new Map<string, string>(),
      }));
      registerSseClient(sessionId, response as unknown as ServerResponse);

      if (outcome === "HTTP 400") {
        // A recent MCP reconnect must not turn a deterministic model rejection
        // into a retried prompt and an indefinitely open progress connection.
        vi.spyOn(engine as any, "isMcpReconnectFailure").mockReturnValue(true);
        acpConnection.prompt.mockRejectedValue(new Error("HTTP 400: context length exceeded"));
      } else {
        acpConnection.prompt.mockImplementation(async () => {
          (engine as any).handleAcpSessionUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial output" },
          });
          if (outcome === "streamed error") {
            (engine as any).handleAcpSessionUpdate(sessionId, {
              sessionUpdate: "error", message: "HTTP 400: context length exceeded",
            });
          }
          return { stopReason: outcome === "streamed error" ? "end_turn" : outcome };
        });
      }
      vi.useFakeTimers();
      const prompting = engine.prompt(sessionId, [{ type: "text", text: "test" }]);
      await vi.advanceTimersByTimeAsync(1201);
      await prompting;

      const expectedReason = ["end_turn", "cancelled"].includes(outcome) ? outcome : "error";
      const envelopes = frames.map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
      const terminal = envelopes.filter((event) => event.messageType === "sessionPromptEnd");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ subType: expectedReason, data: { reason: expectedReason } });
      expect(response.end).toHaveBeenCalledTimes(1);
      expect(sentAtClose[0]).toEqual(frames);
      expect(sseClients.has(sessionId)).toBe(false);
      expect(acpConnection.prompt).toHaveBeenCalledTimes(1);
      if (expectedReason === "error") {
        expect(terminal[0].data.description).toContain(outcome === "streamed error" ? "HTTP 400" : outcome);
        expect(send).toHaveBeenCalledWith("agent:event", expect.objectContaining({ type: "session.error" }));
        expect(send).not.toHaveBeenCalledWith("agent:event", expect.objectContaining({ type: "session.idle" }));
      }
      if (outcome !== "HTTP 400") {
        expect(envelopes.some((event) => event.data?.content?.text === "partial output")).toBe(true);
      }
    },
  );
});

describe("AcpEngine prompt failure reporting", () => {
  it.each(["max_tokens", "max_turn_requests", "refusal", "error", "unknown", undefined])(
    "reports %s through the terminal error event instead of successful idle",
    async (stopReason) => {
      const { engine, sessionId, session, acpConnection } = setupEngine();
      const ended = vi.fn(), failed = vi.fn(), idle = vi.fn();
      engine.on("computer:promptEnd", ended);
      engine.on("session.error", failed);
      engine.on("session.idle", idle);
      vi.spyOn(engine as any, "isMcpReconnectFailure").mockReturnValue(true);
      acpConnection.prompt.mockResolvedValueOnce({ stopReason });

      await engine.prompt(sessionId, [{ type: "text", text: "test" }]);

      expect(ended).toHaveBeenCalledTimes(1);
      expect(ended).toHaveBeenCalledWith(expect.objectContaining({
        sessionId, reason: "error", description: expect.stringContaining(stopReason ?? "missing stopReason"),
      }));
      expect(failed).toHaveBeenCalledTimes(1);
      expect(idle).not.toHaveBeenCalled();
      expect(acpConnection.prompt).toHaveBeenCalledTimes(1);
      expect(session.status).toBe("idle");
      expect((engine as any).activePromptSessions.has(sessionId)).toBe(false);
      expect(engine.listenerCount("computer:progress")).toBe(0);
    },
  );

  it.each([
    new Error("HTTP 400: context length exceeded"),
    new Error("API Error: 400 context length exceeded"),
    new Error("400 Bad Request"),
    Object.assign(new Error("Bad Request"), { status: 400 }),
    Object.assign(new Error("Bad Request"), { statusCode: "400" }),
  ])("keeps bad-request details without retry during an MCP reconnect: %s", async (error) => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const ended = vi.fn();
    engine.on("computer:promptEnd", ended);
    vi.spyOn(engine as any, "isMcpReconnectFailure").mockReturnValue(true);
    acpConnection.prompt.mockRejectedValue(error);

    vi.useFakeTimers();
    try {
      const prompting = engine.prompt(sessionId, [{ type: "text", text: "test" }]);
      await vi.advanceTimersByTimeAsync(1201);
      await prompting;
    } finally {
      vi.useRealTimers();
    }

    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      reason: "error", description: error.message,
    }));
    expect(acpConnection.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a streamed upstream error with end_turn or leak it into the next turn", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const otherSessionId = "unrelated-session";
    (engine as any).sessions.set(otherSessionId, { id: otherSessionId, status: "active" });
    const ended = vi.fn(), idle = vi.fn();
    engine.on("computer:promptEnd", ended);
    engine.on("session.idle", idle);
    acpConnection.prompt.mockImplementationOnce(async () => {
      (engine as any).handleAcpSessionUpdate(sessionId, {
        sessionUpdate: "error", message: "HTTP 400: context length exceeded",
      });
      return { stopReason: "end_turn" };
    });
    await engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    expect(ended).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: "error", description: "HTTP 400: context length exceeded",
    }));
    expect(idle).not.toHaveBeenCalled();

    acpConnection.prompt.mockImplementationOnce(async () => {
      (engine as any).handleAcpSessionUpdate(otherSessionId, {
        sessionUpdate: "error", message: "another session failed",
      });
      return { stopReason: "end_turn" };
    });
    await engine.prompt(sessionId, [{ type: "text", text: "retry" }]);
    expect(ended).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "end_turn" }));
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("keeps resolved cancellation distinct from failure", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const ended = vi.fn(), failed = vi.fn();
    engine.on("computer:promptEnd", ended);
    engine.on("session.error", failed);
    acpConnection.prompt.mockResolvedValueOnce({ stopReason: "cancelled" });
    await engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled" }));
    expect(failed).not.toHaveBeenCalled();
  });
});
