import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_DATA_DIR_NAME } from "../constants";

const mocks = vi.hoisted(() => ({
  bundledDir: vi.fn<() => string | null>(),
  enginePath: vi.fn<() => string | null>(),
  install: vi.fn(),
  exists: vi.fn(),
  read: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  mkdirSync: mocks.mkdir,
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../system/dependencies", () => ({
  getHarnessAcpBundledDir: mocks.bundledDir,
  resolveBundledHarnessEnginePath: mocks.enginePath,
  installNpmPackage: mocks.install,
  getNuwaxcodeBundledBinPath: vi.fn(() => null),
  getAppEnv: vi.fn(() => ({})),
  applySharedPackageManagerCacheEnv: vi.fn(),
}));
vi.mock("../packages/mcp", () => ({
  mcpProxyManager: { getAgentMcpConfig: vi.fn(() => null) },
}));
import {
  createIsolatedEnvironment,
  findEngineBinary,
  getEngineVersion,
  installEngine,
  isEngineInstalledLocally,
} from "./engineManager";

describe("Nuwax Harness engine management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bundledDir.mockReturnValue("/resources/nuwax-harness-acp-ts");
    mocks.enginePath.mockReturnValue("/resources/vendor/nuwax-harness");
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue('{"version":"1.2.24"}');
  });

  it("finds the bundled adapter and reads its package version", async () => {
    expect(findEngineBinary("codex-cli")).toBe(
      "/resources/nuwax-harness-acp-ts/dist/index.js",
    );
    expect(await getEngineVersion("codex-cli")).toBe("1.2.24");
    expect(isEngineInstalledLocally("codex-cli")).toBe(true);
  });

  it("does not report installed when the native harness engine is missing", () => {
    mocks.enginePath.mockReturnValue(null);
    expect(isEngineInstalledLocally("codex-cli")).toBe(false);
  });

  it("finds the adapter repaired through the application npm installer", () => {
    mocks.bundledDir.mockReturnValue(null);
    const adapterDir = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      APP_DATA_DIR_NAME,
      "node_modules",
      "@nuwax-ai/nuwax-harness-acp-ts",
    );
    mocks.exists.mockImplementation(
      (file) =>
        file === adapterDir || file === path.join(adapterDir, "dist/index.js"),
    );
    expect(findEngineBinary("codex-cli")).toBe(
      path.join(adapterDir, "dist/index.js"),
    );
  });

  it("reports a missing adapter", () => {
    mocks.bundledDir.mockReturnValue(null);
    mocks.exists.mockReturnValue(false);
    expect(findEngineBinary("codex-cli")).toBeNull();
  });

  it("installs the harness adapter through the same application npm path", async () => {
    mocks.install.mockResolvedValue({ success: true });
    expect(
      await installEngine("codex-cli", {
        registry: "https://registry.example.test",
      }),
    ).toEqual({ success: true });
    expect(mocks.install).toHaveBeenCalledWith(
      "@nuwax-ai/nuwax-harness-acp-ts",
      { version: "1.2.24", registry: "https://registry.example.test" },
    );
  });

  it("passes the native engine path and isolates Codex state", () => {
    const { env } = createIsolatedEnvironment({
      engine: "codex-cli",
      model: "test-model",
    });
    expect(env.NUWAX_PATH).toBe("/resources/vendor/nuwax-harness");
    expect(env.CODEX_MODEL).toBe("test-model");
    expect(env.CODEX_HOME).toBe(path.join(env.HOME, ".codex"));
    expect(env.CODEX_SQLITE_HOME).toBe(env.CODEX_HOME);
    expect(mocks.mkdir).toHaveBeenCalledWith(env.CODEX_HOME, {
      recursive: true,
    });
  });
});
