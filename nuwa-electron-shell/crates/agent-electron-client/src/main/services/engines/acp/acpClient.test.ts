import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOpenAICompatibleEnv,
  resolveOpenAICompatModel,
  type OpenAICompatInput,
} from "./openAICompatRouting";

const mockGetNodeBinPathWithFallback = vi.fn(
  () =>
    "/Applications/NuwaClaw.app/Contents/Resources/node/darwin-arm64/bin/node",
);
const mockResolveCustomAgentBinary = vi.fn(() => null);
const mockHarnessBundledDir = vi.fn<() => string | null>(() => null);
const mockResolveHarnessAcp = vi.fn();

vi.mock("@nuwax-ai/agent-kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nuwax-ai/agent-kit")>()),
  resolveHarnessAcp: (...args: unknown[]) => mockResolveHarnessAcp(...args),
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    getAppPath: vi.fn(() => "/tmp/app"),
  },
}));

vi.mock("../../system/dependencies", () => ({
  getAppEnv: vi.fn(() => ({ PATH: "/mock" })),
  applySharedPackageManagerCacheEnv: vi.fn(
    (env: Record<string, string>) => env,
  ),
  getNuwaxcodeBundledBinPath: vi.fn(() => null),
  getHarnessAcpBundledDir: () => mockHarnessBundledDir(),
  resolveBundledHarnessEnginePath: vi.fn(() => null),
  getNodeBinPathWithFallback: () => mockGetNodeBinPathWithFallback(),
  getClaudeCodeAcpBundledDir: vi.fn(() => null),
}));

vi.mock("../../agentInstaller", () => ({
  resolveCustomAgentBinary: (...args: unknown[]) =>
    mockResolveCustomAgentBinary(...args),
}));

vi.mock("../../utils/spawnNoWindow", () => ({
  spawnJsFile: vi.fn(),
  resolveNpmPackageEntry: vi.fn(),
  resolveNpmBinShimSpawnTarget: vi.fn(() => null),
}));

function createBaseConfig(
  overrides: Partial<OpenAICompatInput>,
): OpenAICompatInput {
  return {
    ...overrides,
  };
}

describe("resolveOpenAICompatModel", () => {
  it("strips openai-compatible prefix for provider model env vars", () => {
    expect(
      resolveOpenAICompatModel({ model: "openai-compatible/glm-5" }),
    ).toEqual({
      rawModel: "openai-compatible/glm-5",
      providerModel: "glm-5",
      isOpenAICompatibleModel: true,
    });
  });

  it("uses default_model when model is not present", () => {
    expect(
      resolveOpenAICompatModel({ defaultModel: "openai-compatible/qwen-max" }),
    ).toEqual({
      rawModel: "openai-compatible/qwen-max",
      providerModel: "qwen-max",
      isOpenAICompatibleModel: true,
    });
  });

  it("prefers request env model over fallback model fields", () => {
    expect(
      resolveOpenAICompatModel({
        model: "openai-compatible/qwen-max",
        defaultModel: "openai-compatible/deepseek-chat",
        envModel: "openai-compatible/glm-5",
      }),
    ).toEqual({
      rawModel: "openai-compatible/glm-5",
      providerModel: "glm-5",
      isOpenAICompatibleModel: true,
    });
  });

  it("keeps provider-native model names unchanged", () => {
    expect(resolveOpenAICompatModel({ model: "glm-5" })).toEqual({
      rawModel: "glm-5",
      providerModel: "glm-5",
      isOpenAICompatibleModel: false,
    });
  });
});

describe("applyOpenAICompatibleEnv", () => {
  it("nuwaxcode injects standard OpenAI-compatible env vars", () => {
    const env: Record<string, string> = {};
    const config = createBaseConfig({
      engineType: "nuwaxcode",
      apiProtocol: "openai",
      baseUrl: "https://api.qwen.example.com/v1",
      apiKey: "sk-qwen",
      model: "openai-compatible/qwen-max",
    });

    const result = applyOpenAICompatibleEnv(config, env);

    expect(result.isOpenAICompatible).toBe(true);
    expect(env.OPENAI_API_KEY).toBe("sk-qwen");
    expect(env.OPENAI_BASE_URL).toBe("https://api.qwen.example.com/v1");
  });

  it("does not inject OpenAI env vars for provider-native models", () => {
    const env: Record<string, string> = {};
    const config = createBaseConfig({
      engineType: "nuwaxcode",
      apiProtocol: "anthropic",
      baseUrl: "https://anthropic.example.com",
      apiKey: "sk-anthropic",
      model: "claude-sonnet-4-5",
    });

    const result = applyOpenAICompatibleEnv(config, env);

    expect(result.isOpenAICompatible).toBe(false);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("resolveAcpBinary — Nuwax Harness", () => {
  beforeEach(() => {
    mockHarnessBundledDir.mockReset();
    mockHarnessBundledDir.mockReturnValue("/resources/nuwax-harness-acp-ts");
    mockResolveHarnessAcp.mockReset();
    mockResolveHarnessAcp.mockImplementation((options) => ({
      command: process.execPath,
      args: [
        options?.entryOverride || "/npm/nuwax-harness-acp-ts/dist/index.js",
      ],
    }));
  });

  it.each(["codex", "codex-cli"])(
    "starts %s via the bundled harness adapter",
    async (engine) => {
      const { resolveAcpBinary } = await import("./acpClient");
      expect(resolveAcpBinary(engine)).toEqual({
        binPath: "/resources/nuwax-harness-acp-ts/dist/index.js",
        binArgs: [],
        isNative: false,
      });
      expect(mockResolveHarnessAcp).toHaveBeenCalledWith({
        entryOverride: "/resources/nuwax-harness-acp-ts/dist/index.js",
      });
    },
  );

  it("reports adapter resolution failure without starting a different engine", async () => {
    mockHarnessBundledDir.mockReturnValue(null);
    mockResolveHarnessAcp.mockImplementation(() => {
      throw new Error("Nuwax Harness adapter missing");
    });
    const { resolveAcpBinary } = await import("./acpClient");
    expect(() => resolveAcpBinary("codex-cli")).toThrow(
      "Nuwax Harness adapter missing",
    );
    expect(mockResolveCustomAgentBinary).not.toHaveBeenCalled();
  });
});

describe("resolveAcpBinary — custom node agent", () => {
  beforeEach(() => {
    mockGetNodeBinPathWithFallback.mockReset();
    mockGetNodeBinPathWithFallback.mockReturnValue(
      "/Applications/NuwaClaw.app/Contents/Resources/node/darwin-arm64/bin/node",
    );
    mockResolveCustomAgentBinary.mockReset();
    mockResolveCustomAgentBinary.mockReturnValue(null);
  });

  it("resolves command=node to bundled Node absolute path", async () => {
    const { resolveAcpBinary, isNodeInterpreterCommand } =
      await import("./acpClient");

    expect(isNodeInterpreterCommand("node")).toBe(true);
    expect(isNodeInterpreterCommand("node.exe")).toBe(true);
    expect(isNodeInterpreterCommand("/usr/bin/node")).toBe(false);

    const resolved = resolveAcpBinary("node");
    expect(resolved.binPath).toBe(
      "/Applications/NuwaClaw.app/Contents/Resources/node/darwin-arm64/bin/node",
    );
    expect(resolved.binArgs).toEqual([]);
    expect(resolved.isNative).toBe(true);
    // 已解析为 bundled node，不应再走 which/PATH 回退
    expect(mockResolveCustomAgentBinary).not.toHaveBeenCalled();
  });

  it("falls through when bundled node is unavailable", async () => {
    mockGetNodeBinPathWithFallback.mockReturnValue(null);
    mockResolveCustomAgentBinary.mockReturnValue(null);

    const { resolveAcpBinary } = await import("./acpClient");
    const resolved = resolveAcpBinary("node");
    // 无 bundled node 时仍回退裸命令名（由 spawn/PATH 处理）
    expect(resolved.binPath).toBe("node");
    expect(mockResolveCustomAgentBinary).toHaveBeenCalledWith("node");
  });
});


vi.mock("./acpProcess", () => ({ spawnAcpProcess: vi.fn() }));
vi.mock("../../system/processRegistry", () => ({
  processRegistry: { register: vi.fn(), unregister: vi.fn() },
}));
vi.mock("../../utils/processTree", () => ({ killProcessTreeGraceful: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../utils/shellProfile", () => ({ writeBundledDevShellProfiles: vi.fn() }));
const diagnosticTestHome = join(tmpdir(), `nw390-client-test-${process.pid}`);
vi.mock("./isolatedHomePaths", () => ({
  resolveIsolatedHomePath: () => ({ homeDir: diagnosticTestHome, runId: "test-run" }),
}));

describe("ACP process failure diagnostics", () => {
  it.each([
    [{ code: "ENOENT", errno: -2, syscall: "spawn /secret/binary" }, { code: "ENOENT", errno: -2, syscall: "spawn" }],
    [{ code: "EPIPE", errno: "EPIPE", syscall: "write" }, { code: "EPIPE", errno: "EPIPE", syscall: "write" }],
    [{ code: "/secret", errno: "secret-token", syscall: "C:\\secret\\binary" }, {}],
  ])("captures safe original errors and terminal state before setup cleanup: %j", async (fields, expected) => {
    const { EventEmitter } = await import("events");
    const { PassThrough, Writable } = await import("stream");
    const fs = await import("fs");
    const log = (await import("electron-log")).default;
    const { spawnAcpProcess } = await import("./acpProcess");
    const { killProcessTreeGraceful } = await import("../../utils/processTree");
    const { createAcpConnection, getAcpProcessSnapshot } = await import("./acpClient");
    const proc = Object.assign(new EventEmitter(), {
      pid: 390, exitCode: 7, signalCode: null, killed: false,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      unref: vi.fn(), kill: vi.fn(),
    });
    vi.mocked(spawnAcpProcess).mockReturnValue(proc as any);
    const failure = new Error("setup failed /secret credential");
    const bridge = vi.spyOn(Writable, "toWeb").mockImplementation(() => {
      expect(proc.listenerCount("error")).toBe(1);
      proc.emit("error", Object.assign(new Error("original /secret credential"), fields));
      throw failure;
    });
    let diagnosticBeforeKill: unknown;
    vi.mocked(killProcessTreeGraceful).mockImplementationOnce(async () => {
      diagnosticBeforeKill = vi.mocked(log.error).mock.calls
        .filter(([message]) => message === "[AcpClient] Post-spawn setup failure diagnostics")
        .at(-1)?.[1];
      proc.killed = true;
    });
    try {
      await expect(createAcpConnection({ binPath: "test-agent", binArgs: [], workspaceDir: tmpdir() } as any, {} as any)).rejects.toBe(failure);
      expect(log.error).toHaveBeenCalledWith("[AcpClient] Process error diagnostics", {
        pid: 390, exitCode: 7, signalCode: null, killed: false, processError: expected,
      });
      expect(diagnosticBeforeKill).toEqual({
        pid: 390, exitCode: 7, signalCode: null, killed: false, processError: expected,
      });
      const snapshot = getAcpProcessSnapshot(proc as any);
      expect(snapshot.processError).toEqual(expected);
      snapshot.processError.code = "MUTATED";
      expect(getAcpProcessSnapshot(proc as any).processError).toEqual(expected);
    } finally {
      bridge.mockRestore();
      fs.rmSync(diagnosticTestHome, { recursive: true, force: true });
    }
  });
});
