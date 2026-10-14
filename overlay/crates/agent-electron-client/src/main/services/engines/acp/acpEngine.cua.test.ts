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


import { cuaSessionAuthority } from "../../cua/sessionAuthority";

describe("AcpEngine Computer Use lifecycle wiring", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cua-"));
    cuaSessionAuthority.configure(dir, (file) => ({ command: "node", args: ["relay"], env: { CAP: file } }), () => {});
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  function bind(engine: AcpEngine, id: string) {
    const servers = [{ name: "cua", env: [] as Array<{ name: string; value: string }> }];
    (engine as any).cuaSessions.prepare(servers).bind(id);
    return fs.readFileSync(servers[0].env[0].value, "utf8");
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
    expect(cuaSessionAuthority.authorize(fs.readFileSync(first.env[0].value, "utf8"))).toBeNull();
    await engine.destroy(); expect(fs.readdirSync(dir)).toEqual([]);
  });
  it.each(["resumeAcpSession", "loadAcpSession"] as const)("rotates credentials through %s", async (method) => {
    const { engine } = setupEngineForCreateSession();
    (engine as any).config.mcpServers = { cua: { command: "old-helper", args: [] } };
    const rpc = vi.fn().mockResolvedValue({});
    (engine as any).acpConnection[method === "resumeAcpSession" ? "resumeSession" : "loadSession"] = rpc;
    const old = bind(engine, "same");
    (engine as any).cuaSessions.start("same");
    await engine[method]("same");
    expect(cuaSessionAuthority.authorize(old)).toBeNull();
    expect(rpc.mock.calls[0][0].mcpServers[0].args).toEqual(["relay"]);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    await engine.destroy();
  });
  it("allows only the active prompt and revokes before awaiting ACP cancellation", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const secret = bind(engine, sessionId), reply = createDeferred<any>(), cancelled = createDeferred<void>();
    acpConnection.prompt.mockReturnValue(reply.promise); acpConnection.cancel.mockReturnValue(cancelled.promise);
    const prompting = engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    expect(cuaSessionAuthority.authorize(secret)).toBeTruthy();
    const aborting = engine.abortSession(sessionId);
    expect(cuaSessionAuthority.authorize(secret)).toBeNull();
    cancelled.resolve(); reply.resolve({ stopReason: "end_turn" });
    await aborting; await prompting; await engine.destroy();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it("never retries an uncertain prompt when desktop capabilities are attached", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const secret = bind(engine, sessionId);
    vi.spyOn(engine as any, "isMcpReconnectFailure").mockReturnValue(true);
    acpConnection.prompt.mockRejectedValue(new Error("MCP connection lost"));
    await engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    expect(acpConnection.prompt).toHaveBeenCalledTimes(1);
    expect(cuaSessionAuthority.authorize(secret)).toBeNull();
    await engine.destroy();
  });
  it("revokes before engine destruction waits for ACP and clears late prompt results", async () => {
    const { engine, sessionId, acpConnection } = setupEngine();
    const secret = bind(engine, sessionId), reply = createDeferred<any>(), cancelled = createDeferred<void>();
    acpConnection.prompt.mockReturnValue(reply.promise); acpConnection.cancel.mockReturnValue(cancelled.promise);
    const prompting = engine.prompt(sessionId, [{ type: "text", text: "test" }]);
    const destroying = engine.destroy();
    expect(cuaSessionAuthority.authorize(secret)).toBeNull(); expect(fs.readdirSync(dir)).toEqual([]);
    cancelled.resolve(); reply.resolve({ stopReason: "end_turn" });
    await destroying; await prompting;
    expect(cuaSessionAuthority.authorize(secret)).toBeNull();
  });
});
