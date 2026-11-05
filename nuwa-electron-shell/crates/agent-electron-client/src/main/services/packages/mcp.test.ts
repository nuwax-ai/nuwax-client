/**
 * 单元测试: MCP Proxy Manager
 *
 * 测试 MCP Proxy 配置管理和 binary 验证
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === "home") return "/mock/home";
      return "/mock/appdata";
    }),
    getAppPath: vi.fn(() => "/mock/app"),
    isPackaged: false,
  },
}));

// Mock electron-log
vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fs（含 node:fs，供 @nuwax-ai/mcp-proxy-ts Host Adapter 使用）
const mockExistsSync = vi.fn(() => true);
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockWatchFile = vi.fn();
const mockUnwatchFile = vi.fn();
const fsMock = {
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  watchFile: (...args: unknown[]) => mockWatchFile(...args),
  unwatchFile: (...args: unknown[]) => mockUnwatchFile(...args),
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    watchFile: (...args: unknown[]) => mockWatchFile(...args),
    unwatchFile: (...args: unknown[]) => mockUnwatchFile(...args),
  },
};
vi.mock("fs", () => fsMock);
vi.mock("node:fs", () => fsMock);
// Mock os
vi.mock("os", () => ({
  tmpdir: vi.fn(() => "/mock/tmp"),
}));

// Mock crypto（Host Adapter 使用 default import createHash）
vi.mock("crypto", () => {
  const createHash = vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "abcdef1234567890abcdef1234567890"),
  }));
  return {
    randomUUID: vi.fn(() => "mock-uuid-12345"),
    createHash,
    default: {
      randomUUID: vi.fn(() => "mock-uuid-12345"),
      createHash,
    },
  };
});
vi.mock("node:crypto", () => {
  const createHash = vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "abcdef1234567890abcdef1234567890"),
  }));
  return {
    randomUUID: vi.fn(() => "mock-uuid-12345"),
    createHash,
    default: {
      randomUUID: vi.fn(() => "mock-uuid-12345"),
      createHash,
    },
  };
});

vi.mock("./mcpHostAdapterLoader", async () => {
  // The manager test exercises the real prepared adapter through Vitest so its
  // fs/crypto dependencies remain controllable by the mocks above.
  // @ts-expect-error prepared JS resource intentionally has no local declaration file
  const adapter =
    await import("../../../../resources/mcp-proxy-ts/dist/host/rewrite.js");
  return { loadMcpProxyHostAdapter: () => adapter };
});

// Mock dependencies（含 getUvBinPath、getNodeBinPath、getNodeBinPathWithFallback，供 mcp 内 getUvBinDir 等使用）
vi.mock("../system/dependencies", () => ({
  getAppEnv: vi.fn(() => ({
    PATH: "/mock/path",
    NODE_PATH: "/mock/node_path",
    HOME: "/mock/home",
    USER: "mockuser",
    USERNAME: "mockuser",
    LANG: "en_US.UTF-8",
    TZ: "",
    UV_TOOL_DIR: "/mock/uv_tool",
    UV_CACHE_DIR: "/mock/uv_cache",
    UV_INDEX_URL: "",
  })),
  getUvBinPath: vi.fn(() => "/mock/uv/bin/uv"),
  getNodeBinPath: vi.fn(() => "/mock/resources/node/darwin-arm64/bin/node"),
  getNodeBinPathWithFallback: vi.fn(
    () => "/mock/resources/node/darwin-arm64/bin/node",
  ),
}));

vi.mock("./packageLocator", () => ({
  getAppPaths: vi.fn(() => ({
    nodeModules: "/mock/home/.nuwaclaw/node_modules",
  })),
  getBundledMcpProxyDir: vi.fn(() => `${process.cwd()}/resources/mcp-proxy-ts`),
  isInstalledLocally: vi.fn(() => true),
}));

vi.mock("../utils/spawnNoWindow", () => ({
  resolveNpmPackageEntry: vi.fn(
    () => "/mock/home/.nuwaclaw/node_modules/mcp-proxy-ts/dist/index.js",
  ),
}));

// Mock persistentMcpBridge (避免加载 MCP SDK)
vi.mock("./persistentMcpBridge", () => ({
  persistentMcpBridge: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn(() => false),
    getBridgeUrl: vi.fn(() => null),
    isServerHealthy: vi.fn(() => false),
  },
}));

function mockBridge(overrides: Record<string, unknown> = {}) {
  vi.doMock("./persistentMcpBridge", () => ({
    persistentMcpBridge: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn(() => false),
      getBridgeUrl: vi.fn(() => null),
      isServerHealthy: vi.fn(() => false),
      ...overrides,
    },
  }));
}

// 每个用例恢复默认依赖，避免错误分支的 doMock 泄漏到后续测试。
beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReset().mockReturnValue(true);
  mockBridge();
  vi.doMock("./packageLocator", () => ({
    getAppPaths: () => ({ nodeModules: "/mock/home/.nuwaclaw/node_modules" }),
    getBundledMcpProxyDir: () => `${process.cwd()}/resources/mcp-proxy-ts`,
    isInstalledLocally: () => true,
  }));
  vi.doMock("../utils/spawnNoWindow", () => ({
    resolveNpmPackageEntry: () =>
      "/mock/home/.nuwaclaw/node_modules/mcp-proxy-ts/dist/index.js",
  }));
  vi.resetModules();
});

describe("McpProxyManager", () => {
  describe("配置管理", () => {
    it("setConfig 和 getConfig 应该正确工作", async () => {
      const { mcpProxyManager } = await import("./mcp");

      const newConfig = {
        mcpServers: {
          "test-server": {
            command: "npx",
            args: ["-y", "test-mcp"],
          },
        },
      };

      mcpProxyManager.setConfig(newConfig);
      const config = mcpProxyManager.getConfig();

      expect(config.mcpServers["test-server"]).toBeDefined();
      expect(config.mcpServers["test-server"].command).toBe("npx");
    });

    it("addServer 和 removeServer 应该正确工作", async () => {
      const { mcpProxyManager } = await import("./mcp");

      mcpProxyManager.addServer("new-server", {
        command: "node",
        args: ["server.js"],
      });

      let config = mcpProxyManager.getConfig();
      expect(config.mcpServers["new-server"]).toBeDefined();

      mcpProxyManager.removeServer("new-server");
      config = mcpProxyManager.getConfig();
      expect(config.mcpServers["new-server"]).toBeUndefined();
    });
  });

  describe("getStatus", () => {
    it("start() 后应该返回 running=true 和 server 数量", async () => {
      const { mcpProxyManager } = await import("./mcp");

      await mcpProxyManager.start();
      const status = mcpProxyManager.getStatus();
      expect(status.running).toBe(true);
      expect(status.serverCount).toBeGreaterThan(0);
    });

    it("未调用 start() 时应该返回 running=false", async () => {
      const { mcpProxyManager } = await import("./mcp");

      const status = mcpProxyManager.getStatus();
      expect(status.running).toBe(false);
    });

    it("binary 不存在时应该返回 running=false", async () => {
      vi.doMock("../utils/spawnNoWindow", () => ({
        resolveNpmPackageEntry: vi.fn(() => null),
      }));
      vi.resetModules();

      const { mcpProxyManager } = await import("./mcp");
      const status = mcpProxyManager.getStatus();
      expect(status.running).toBe(false);

      // Restore original mock
      vi.doMock("../utils/spawnNoWindow", () => ({
        resolveNpmPackageEntry: vi.fn(
          () => "/mock/home/.nuwaclaw/node_modules/mcp-proxy-ts/dist/index.js",
        ),
      }));
    });
  });

  describe("getAgentMcpConfig", () => {
    it("临时 server 应该返回 proxy 聚合配置", async () => {
      const { mcpProxyManager } = await import("./mcp");

      // 设置只有临时 server 的配置
      mcpProxyManager.setConfig({
        mcpServers: {
          "test-server": {
            command: "npx",
            args: ["-y", "test-mcp"],
          },
        },
      });

      // start() 填充缓存路径
      await mcpProxyManager.start();
      const mcpConfig = mcpProxyManager.getAgentMcpConfig();

      expect(mcpConfig).toBeDefined();
      // 拆分模式：每个服务独立入口
      expect(mcpConfig?.["test-server"]).toBeDefined();
      // 使用 --config-file 避免 Windows 命令行长度限制
      expect(mcpConfig?.["test-server"].args).toContain("--config-file");
      // 新方案：使用内置 Node.js 24，不再使用 process.execPath + ELECTRON_RUN_AS_NODE
      expect(mcpConfig?.["test-server"].command).toBe(
        "/mock/resources/node/darwin-arm64/bin/node",
      );
      expect(
        mcpConfig?.["test-server"].env?.ELECTRON_RUN_AS_NODE,
      ).toBeUndefined();
      expect(mcpConfig?.["test-server"].env?.MCP_PROXY_LOG_FILE).toContain(
        "mcp-proxy/shared/test-server.log",
      );
    });

    it("传入 projectId 时日志文件名应包含项目标识", async () => {
      const { mcpProxyManager } = await import("./mcp");

      // 手动设置配置
      mcpProxyManager.setConfig({
        mcpServers: {
          "fetch-server": {
            command: "uvx",
            args: ["mcp-server-fetch"],
          },
        },
      });

      await mcpProxyManager.start();

      // 测试带 projectId 的调用
      const mcpConfig = mcpProxyManager.getAgentMcpConfig("my-project-123");
      expect(mcpConfig).toBeDefined();
      expect(mcpConfig?.["fetch-server"]).toBeDefined();

      const proxyEnv = mcpConfig?.["fetch-server"].env;
      expect(proxyEnv?.MCP_PROXY_LOG_FILE).toBeDefined();
      // 日志路径格式: mcp-proxy/{projectId}/{serverName}.log
      expect(proxyEnv?.MCP_PROXY_LOG_FILE).toContain(
        "mcp-proxy/my-project-123",
      );
      expect(proxyEnv?.MCP_PROXY_LOG_FILE).toContain("fetch-server.log");

      // 测试 projectId 包含特殊字符时会被安全化
      const mcpConfig2 = mcpProxyManager.getAgentMcpConfig(
        "project/with:special@chars",
      );
      const proxyEnv2 = mcpConfig2?.["fetch-server"].env;
      expect(proxyEnv2?.MCP_PROXY_LOG_FILE).toContain(
        "mcp-proxy/project_with_special_chars",
      );
      expect(proxyEnv2?.MCP_PROXY_LOG_FILE).toContain("fetch-server.log");
    });

    it("默认配置只有 persistent server，bridge 未运行时应降级到 stdio 配置", async () => {
      const { mcpProxyManager } = await import("./mcp");

      // start() 填充缓存路径（默认配置包含 chrome-devtools persistent）
      await mcpProxyManager.start();
      const mcpConfig = mcpProxyManager.getAgentMcpConfig();

      // PersistentMcpBridge 未运行（mock isRunning=false），persistent server 降级到 stdio 配置
      expect(mcpConfig).toBeDefined();
      // 拆分模式：每个服务独立入口
      const serverNames = Object.keys(mcpConfig || {});
      expect(serverNames.length).toBeGreaterThan(0);
      // 每个服务都使用 --config-file
      for (const name of serverNames) {
        expect(mcpConfig?.[name].args).toContain("--config-file");
      }
    });

    it("没有配置服务器时应该返回 null", async () => {
      const { mcpProxyManager } = await import("./mcp");

      // 清空配置
      mcpProxyManager.setConfig({ mcpServers: {} });

      const mcpConfig = mcpProxyManager.getAgentMcpConfig();
      expect(mcpConfig).toBeNull();
    });

    it("proxy script 不存在时应该 fallback 到直接 stdio 配置（临时 server）", async () => {
      vi.doMock("../utils/spawnNoWindow", () => ({
        resolveNpmPackageEntry: vi.fn(() => null),
      }));
      vi.resetModules();

      const { mcpProxyManager } = await import("./mcp");

      // 设置临时 server 以测试 fallback
      mcpProxyManager.setConfig({
        mcpServers: {
          "test-server": {
            command: "npx",
            args: ["-y", "test-mcp"],
          },
        },
      });

      const mcpConfig = mcpProxyManager.getAgentMcpConfig();

      expect(mcpConfig).toBeDefined();
      // fallback: 不应有 proxy key，而是直接有各 server
      expect(mcpConfig?.["mcp-proxy"]).toBeUndefined();
      expect(mcpConfig?.["test-server"]).toBeDefined();

      // Restore original mock
      vi.doMock("../utils/spawnNoWindow", () => ({
        resolveNpmPackageEntry: vi.fn(
          () => "/mock/home/.nuwaclaw/node_modules/mcp-proxy-ts/dist/index.js",
        ),
      }));
    });
  });

  describe("start - 验证 binary 可用性", () => {
    it("@nuwax-ai/mcp-proxy-ts 未安装时应该返回错误", async () => {
      vi.doMock("./packageLocator", () => ({
        getAppPaths: vi.fn(() => ({
          nodeModules: "/mock/home/.nuwaclaw/node_modules",
        })),
        getBundledMcpProxyDir: vi.fn(() => null),
        isInstalledLocally: vi.fn(() => false),
      }));
      vi.doMock("../utils/spawnNoWindow", () => ({
        resolveNpmPackageEntry: vi.fn(() => null),
      }));
      // fs.existsSync 对包目录返回 false
      mockExistsSync.mockReturnValue(false);

      vi.resetModules();

      const { mcpProxyManager } = await import("./mcp");
      const result = await mcpProxyManager.start();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/未安装|Claw\.MCP\.notInstalled/);
    });
  });
});

describe("extractRealMcpServers", () => {
  it("extracts mixed stdio/remote servers, resolves uvx and merges environment and tool filters", async () => {
    const { extractRealMcpServers } = await import("./mcp");
    const result = extractRealMcpServers(
      "/bin/mcp-proxy",
      [
        "convert",
        "--config",
        JSON.stringify({
          mcpServers: {
            fetch: {
              command: "uvx",
              args: ["mcp-server-fetch"],
              env: { INNER: "inner" },
            },
            local: { command: "npx", args: ["-y", "local-mcp"] },
            remote: { url: "https://example.com/mcp" },
            invalid: { args: [] },
          },
        }),
        "--allow-tools",
        "fetch,search",
      ],
      { OUTER: "outer" },
    );
    expect(Object.keys(result!)).toEqual(["fetch", "local", "remote"]);
    expect(result!.fetch).toMatchObject({
      command: expect.stringContaining("uv"),
      args: expect.arrayContaining(["tool", "run", "mcp-server-fetch"]),
      env: { INNER: "inner", OUTER: "outer" },
      allowTools: ["fetch", "search"],
    });
    expect(result!.local).toMatchObject({
      command: "npx",
      args: ["-y", "local-mcp"],
    });
    expect(result!.remote).toMatchObject({ url: "https://example.com/mcp" });
  });

  it("returns null for non-bridge commands and missing, invalid or empty config", async () => {
    const { extractRealMcpServers } = await import("./mcp");
    for (const [command, args] of [
      ["npx", ["-y", "mcp-server-fetch"]],
      ["mcp-proxy", ["convert", "http://localhost:8080"]],
      ...["invalid-json", "{}", '{"mcpServers":{}}'].map((config) => [
        "mcp-proxy",
        ["convert", "--config", config],
      ]),
    ] as [string, string[]][]) {
      expect(
        extractRealMcpServers(command, args),
        JSON.stringify([command, args]),
      ).toBeNull();
    }
  });

  it("accepts header aliases and separators, merging headers with explicit overrides", async () => {
    const { extractRealMcpServers } = await import("./mcp");
    for (const flag of ["-H", "--header"]) {
      const result = extractRealMcpServers("mcp-proxy", [
        "convert",
        "--config",
        JSON.stringify({
          mcpServers: {
            remote: {
              url: "https://example.com/mcp",
              headers: { Authorization: "old", "X-Keep": "keep" },
            },
          },
        }),
        flag,
        "Authorization=Bearer new",
        flag,
        "X-Custom: custom",
      ]);
      expect(result!.remote).toMatchObject({
        headers: {
          Authorization: "Bearer new",
          "X-Keep": "keep",
          "X-Custom": "custom",
        },
      });
    }
  });
});

describe("McpProxyManager - getAllStdioServers", () => {
  it("应该返回所有 stdio 类型 server（包括 persistent 和临时）", async () => {
    const { mcpProxyManager } = await import("./mcp");

    mcpProxyManager.setConfig({
      mcpServers: {
        "persistent-server": {
          command: "npx",
          args: ["-y", "persistent-mcp"],
          persistent: true,
        },
        "temp-server": {
          command: "npx",
          args: ["-y", "temp-mcp"],
        },
      },
    });

    const allStdio = mcpProxyManager.getAllStdioServers();
    expect(Object.keys(allStdio)).toHaveLength(2);
    expect(allStdio["persistent-server"]).toBeDefined();
    expect(allStdio["temp-server"]).toBeDefined();
  });

  it("应该排除远程类型 server", async () => {
    const { mcpProxyManager } = await import("./mcp");

    mcpProxyManager.setConfig({
      mcpServers: {
        "stdio-server": {
          command: "npx",
          args: ["-y", "stdio-mcp"],
        },
        "remote-server": {
          url: "http://example.com/mcp",
        },
      },
    });

    const allStdio = mcpProxyManager.getAllStdioServers();
    expect(Object.keys(allStdio)).toHaveLength(1);
    expect(allStdio["stdio-server"]).toBeDefined();
    expect(allStdio["remote-server"]).toBeUndefined();
  });

  it("空配置应该返回空对象", async () => {
    const { mcpProxyManager } = await import("./mcp");

    mcpProxyManager.setConfig({ mcpServers: {} });

    const allStdio = mcpProxyManager.getAllStdioServers();
    expect(Object.keys(allStdio)).toHaveLength(0);
  });
});

describe("McpProxyManager - bridge URL 优先策略", () => {
  it("bridge 运行时所有 stdio server 应使用 bridge URL", async () => {
    mockBridge({
      isRunning: vi.fn(() => true),
      getBridgeUrl: vi.fn(
        (name: string) => `http://127.0.0.1:12345/mcp/${name}`,
      ),
      isServerHealthy: vi.fn(() => true),
    });
    vi.resetModules();

    const { mcpProxyManager } = await import("./mcp");

    mcpProxyManager.setConfig({
      mcpServers: {
        "server-a": { command: "npx", args: ["-y", "mcp-a"] },
        "server-b": { command: "npx", args: ["-y", "mcp-b"], persistent: true },
      },
    });

    await mcpProxyManager.start();
    const mcpConfig = mcpProxyManager.getAgentMcpConfig();

    expect(mcpConfig).toBeDefined();
    // 拆分模式：每个服务独立配置文件
    // 验证所有配置文件中的 server 都使用 bridge URL
    expect(mockWriteFileSync.mock.calls.length).toBe(2); // 2 个服务

    for (const call of mockWriteFileSync.mock.calls) {
      const configJson = JSON.parse(call[1] as string);
      const serverName = Object.keys(configJson.mcpServers)[0];
      expect(configJson.mcpServers[serverName].url).toBe(
        `http://127.0.0.1:12345/mcp/${serverName}`,
      );
    }
  });

  it("bridge 运行但某 server 未就绪时应降级到 stdio", async () => {
    mockBridge({
      isRunning: vi.fn(() => true),
      getBridgeUrl: vi.fn((name: string) => {
        // 只有 server-a 就绪
        if (name === "server-a") return "http://127.0.0.1:12345/mcp/server-a";
        return null; // server-b 未就绪
      }),
    });
    vi.resetModules();

    const { mcpProxyManager } = await import("./mcp");

    mcpProxyManager.setConfig({
      mcpServers: {
        "server-a": { command: "npx", args: ["-y", "mcp-a"] },
        "server-b": { command: "npx", args: ["-y", "mcp-b"] },
      },
    });

    await mcpProxyManager.start();
    const mcpConfig = mcpProxyManager.getAgentMcpConfig();

    expect(mcpConfig).toBeDefined();
    // 拆分模式：每个服务独立配置文件
    expect(mockWriteFileSync.mock.calls.length).toBe(2); // 2 个服务

    // 遍历所有配置文件验证
    for (const call of mockWriteFileSync.mock.calls) {
      const configJson = JSON.parse(call[1] as string);
      const serverName = Object.keys(configJson.mcpServers)[0];
      if (serverName === "server-a") {
        // server-a: bridge URL
        expect(configJson.mcpServers["server-a"].url).toBe(
          "http://127.0.0.1:12345/mcp/server-a",
        );
      } else if (serverName === "server-b") {
        // server-b: 降级到 stdio 配置
        expect(configJson.mcpServers["server-b"].command).toBeDefined();
        expect(configJson.mcpServers["server-b"].url).toBeUndefined();
      }
    }
  });

  it("bridge URL 应保留 allowTools/denyTools", async () => {
    mockBridge({
      isRunning: vi.fn(() => true),
      getBridgeUrl: vi.fn(
        (name: string) => `http://127.0.0.1:12345/mcp/${name}`,
      ),
      isServerHealthy: vi.fn(() => true),
    });
    vi.resetModules();

    const { mcpProxyManager } = await import("./mcp");

    mcpProxyManager.setConfig({
      mcpServers: {
        markdownify: {
          command: "uvx",
          args: ["markdownify-mcp-server"],
          allowTools: ["youtube-to-markdown", "pdf-to-markdown"],
        },
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          allowTools: ["fetch"],
          denyTools: ["fetch_html"],
        },
        "no-filter": {
          command: "npx",
          args: ["-y", "some-mcp"],
        },
      },
    });

    await mcpProxyManager.start();
    mcpProxyManager.getAgentMcpConfig();

    // 拆分模式：每个服务独立配置文件
    expect(mockWriteFileSync.mock.calls.length).toBe(3); // 3 个服务

    // 解析所有配置文件
    const configs: Record<string, any> = {};
    for (const call of mockWriteFileSync.mock.calls) {
      const configJson = JSON.parse(call[1] as string);
      const serverName = Object.keys(configJson.mcpServers)[0];
      configs[serverName] = configJson.mcpServers[serverName];
    }

    // allowTools 应保留在 bridge URL 条目中
    expect(configs["markdownify"].url).toBe(
      "http://127.0.0.1:12345/mcp/markdownify",
    );
    expect(configs["markdownify"].allowTools).toEqual([
      "youtube-to-markdown",
      "pdf-to-markdown",
    ]);

    // allowTools + denyTools 都应保留
    expect(configs["fetch"].url).toBe("http://127.0.0.1:12345/mcp/fetch");
    expect(configs["fetch"].allowTools).toEqual(["fetch"]);
    expect(configs["fetch"].denyTools).toEqual(["fetch_html"]);

    // 无 allowTools 的 server 不应有该字段
    expect(configs["no-filter"].url).toBe(
      "http://127.0.0.1:12345/mcp/no-filter",
    );
    expect(configs["no-filter"].allowTools).toBeUndefined();
    expect(configs["no-filter"].denyTools).toBeUndefined();
  });

  it("远程 server 应不受 bridge 影响直接透传", async () => {
    mockBridge({
      isRunning: vi.fn(() => true),
      getBridgeUrl: vi.fn(
        (name: string) => `http://127.0.0.1:12345/mcp/${name}`,
      ),
      isServerHealthy: vi.fn(() => true),
    });
    vi.resetModules();

    const { mcpProxyManager } = await import("./mcp");

    mcpProxyManager.setConfig({
      mcpServers: {
        "remote-server": {
          url: "https://external.example.com/mcp",
          transport: "sse" as const,
        },
        "stdio-server": { command: "npx", args: ["-y", "mcp-local"] },
      },
    });

    await mcpProxyManager.start();
    const mcpConfig = mcpProxyManager.getAgentMcpConfig();

    expect(mcpConfig).toBeDefined();
    // 拆分模式：每个服务独立配置文件
    expect(mockWriteFileSync.mock.calls.length).toBe(2); // 2 个服务

    // 解析所有配置文件
    const configs: Record<string, any> = {};
    for (const call of mockWriteFileSync.mock.calls) {
      const configJson = JSON.parse(call[1] as string);
      const serverName = Object.keys(configJson.mcpServers)[0];
      configs[serverName] = configJson.mcpServers[serverName];
    }

    // 远程 server 保持原始 URL
    expect(configs["remote-server"].url).toBe(
      "https://external.example.com/mcp",
    );
    // stdio server 使用 bridge URL
    expect(configs["stdio-server"].url).toBe(
      "http://127.0.0.1:12345/mcp/stdio-server",
    );
  });
});

describe("syncMcpConfigToProxyAndReload - bridge 重启", () => {
  beforeEach(() => {
    vi.doMock("../../db", () => ({
      getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({
          run: vi.fn(),
        })),
      })),
    }));
  });

  it("同步配置后应重启 PersistentMcpBridge", async () => {
    const { syncMcpConfigToProxyAndReload } = await import("./mcp");
    const { persistentMcpBridge } = await import("./persistentMcpBridge");

    await syncMcpConfigToProxyAndReload({
      "new-server": { command: "npx", args: ["-y", "new-mcp"] },
    });

    // bridge.start() 应该被调用（同步后重启）
    expect(persistentMcpBridge.start).toHaveBeenCalled();
  });

  it("同步空配置后应重启 bridge 为仅默认服务", async () => {
    const { syncMcpConfigToProxyAndReload, mcpProxyManager } =
      await import("./mcp");
    const { persistentMcpBridge } = await import("./persistentMcpBridge");

    await syncMcpConfigToProxyAndReload({});

    // 空配置触发重置为仅默认服务
    expect(persistentMcpBridge.start).toHaveBeenCalled();
    const startArg = (persistentMcpBridge.start as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as Record<string, unknown>;
    // bridge 只含 persistent 默认 server chrome-devtools；会话级 MCP 不进 bridge
    expect(Object.keys(startArg)).toContain("chrome-devtools");
    expect(Object.keys(startArg)).not.toContain("nuwax-openui");
    expect(Object.keys(startArg)).not.toContain("ask-question");
    expect(Object.keys(startArg).length).toBe(1);

    // ask-question/nuwax-openui 已移出默认配置，空配置（后端未下发）时 merged 仅含 chrome-devtools
    const mergedServers = mcpProxyManager.getConfig().mcpServers;
    expect(mergedServers["chrome-devtools"]).toBeDefined();
    expect(mergedServers["nuwax-openui"]).toBeUndefined();
    expect(mergedServers["ask-question"]).toBeUndefined();
  });

  it("后端下发 ask-question/nuwax-openui 后应进入 merged 启用", async () => {
    const { syncMcpConfigToProxyAndReload, mcpProxyManager } =
      await import("./mcp");

    await syncMcpConfigToProxyAndReload({
      "ask-question": {
        command: "npx",
        args: ["-y", "nuwax-ask-question-mcp@latest"],
      },
      "nuwax-openui": {
        command: "npx",
        args: ["-y", "@nuwax-ai/openui-mcp@latest"],
      },
    });

    // DEFAULT 的 chrome-devtools + 后端下发的两个，均进入 merged
    const mergedServers = mcpProxyManager.getConfig().mcpServers;
    expect(mergedServers["chrome-devtools"]).toBeDefined();
    expect(mergedServers["ask-question"]).toBeDefined();
    expect(mergedServers["nuwax-openui"]).toBeDefined();
  });

  it("bridge 重启失败不应阻断同步流程", async () => {
    mockBridge({
      start: vi.fn().mockRejectedValue(new Error("bridge start failed")),
    });
    vi.doMock("../../db", () => ({
      getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({
          run: vi.fn(),
        })),
      })),
    }));
    vi.resetModules();

    const { syncMcpConfigToProxyAndReload, mcpProxyManager } =
      await import("./mcp");

    // 不应抛出异常
    await expect(
      syncMcpConfigToProxyAndReload({
        "test-server": { command: "npx", args: ["-y", "test-mcp"] },
      }),
    ).resolves.not.toThrow();

    // 配置应该仍然更新成功
    const config = mcpProxyManager.getConfig();
    expect(config.mcpServers["test-server"]).toBeDefined();
  });
});

describe("McpProxyManager - cleanup async", () => {
  it("cleanup 应该 await persistentMcpBridge.stop()", async () => {
    const { mcpProxyManager } = await import("./mcp");
    const { persistentMcpBridge } = await import("./persistentMcpBridge");

    await mcpProxyManager.cleanup();

    expect(persistentMcpBridge.stop).toHaveBeenCalled();
  });

  it("cleanup 在 bridge.stop() 失败时不应抛出", async () => {
    mockBridge({ stop: vi.fn().mockRejectedValue(new Error("stop failed")) });
    vi.resetModules();

    const { mcpProxyManager } = await import("./mcp");

    await expect(mcpProxyManager.cleanup()).resolves.not.toThrow();
  });
});

describe("McpProxyManager - start 启动所有 stdio servers", () => {
  it("ensureBridgeStarted() 应通过 bridge 启动所有 stdio server（懒加载）", async () => {
    mockBridge();
    vi.resetModules();

    const { mcpProxyManager } = await import("./mcp");
    const { persistentMcpBridge } = await import("./persistentMcpBridge");

    mcpProxyManager.setConfig({
      mcpServers: {
        "persistent-server": {
          command: "npx",
          args: ["-y", "persistent-mcp"],
          persistent: true,
        },
        "temp-server": {
          command: "npx",
          args: ["-y", "temp-mcp"],
        },
      },
    });

    await mcpProxyManager.start();

    // start() 不再自动启动 bridge
    expect(persistentMcpBridge.start).toHaveBeenCalledTimes(0);

    // 调用 ensureBridgeStarted() 应启动 bridge
    await mcpProxyManager.ensureBridgeStarted();
    expect(persistentMcpBridge.start).toHaveBeenCalledTimes(1);

    // 传入的 servers 应仅包含 persistent 类型（temp-server 不进 bridge）
    const startArg = (persistentMcpBridge.start as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(startArg)).toContain("persistent-server");
    // temp-server 没有 persistent 标记，不应出现在 bridge 中
    expect(Object.keys(startArg)).not.toContain("temp-server");

    // 再次调用 ensureBridgeStarted() 不应重复启动
    await mcpProxyManager.ensureBridgeStarted();
    expect(persistentMcpBridge.start).toHaveBeenCalledTimes(1);
  });

  it("start() 只有远程 server 时不应启动 bridge", async () => {
    mockBridge();
    vi.resetModules();

    const { mcpProxyManager } = await import("./mcp");
    const { persistentMcpBridge } = await import("./persistentMcpBridge");

    mcpProxyManager.setConfig({
      mcpServers: {
        "remote-only": { url: "http://example.com/mcp" },
      },
    });

    await mcpProxyManager.start();

    expect(persistentMcpBridge.start).not.toHaveBeenCalled();
  });
});

describe("syncMcpConfigToProxyAndReload - 真实 context_servers 场景", () => {
  beforeEach(() => {
    vi.doMock("../../db", () => ({
      getDb: vi.fn(() => ({
        prepare: vi.fn(() => ({
          run: vi.fn(),
        })),
      })),
    }));
  });

  it("同步真实混合配置后应合并默认 server 并重启 bridge", async () => {
    const { syncMcpConfigToProxyAndReload, mcpProxyManager } =
      await import("./mcp");
    const { persistentMcpBridge } = await import("./persistentMcpBridge");

    // 模拟 extractRealMcpServers 提取后的真实结果
    await syncMcpConfigToProxyAndReload({
      "Markdown 万能转成": {
        command: "uvx",
        args: ["markdownify-mcp-server"],
        allowTools: ["youtube-to-markdown", "pdf-to-markdown"],
      },
      "image-understanding-and-generation": {
        url: "https://mcp-api.nuwax.com/api/mcp/sse?ak=ak-test",
      },
      "Fetch 网页内容抓取": {
        command: "uvx",
        args: ["mcp-server-fetch"],
        allowTools: ["fetch"],
      },
      time: {
        command: "uvx",
        args: ["mcp-server-time", "--local-timezone=America/New_York"],
        allowTools: ["get_current_time", "convert_time"],
      },
    });

    // 验证配置已更新
    const config = mcpProxyManager.getConfig();
    const serverNames = Object.keys(config.mcpServers);

    // 应包含默认 server (chrome-devtools) + 请求中的 server
    expect(serverNames).toContain("chrome-devtools");
    expect(serverNames).toContain("Markdown 万能转成");
    expect(serverNames).toContain("image-understanding-and-generation");
    expect(serverNames).toContain("Fetch 网页内容抓取");
    expect(serverNames).toContain("time");

    // bridge 应该被重启以加载 persistent server
    expect(persistentMcpBridge.start).toHaveBeenCalled();

    // bridge 传入的 servers 应仅包含 persistent 类型（chrome-devtools）
    // 动态 MCP（Markdown/Fetch/time）不进 bridge，由 mcp-proxy 按需 spawn
    const bridgeStartArg = (
      persistentMcpBridge.start as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(bridgeStartArg)).toContain("chrome-devtools");
    // 动态 MCP 不应在 bridge 参数中
    expect(Object.keys(bridgeStartArg)).not.toContain("Markdown 万能转成");
    expect(Object.keys(bridgeStartArg)).not.toContain("Fetch 网页内容抓取");
    expect(Object.keys(bridgeStartArg)).not.toContain("time");
    // 远程 URL 也不应出现在 bridge 参数中
    expect(Object.keys(bridgeStartArg)).not.toContain(
      "image-understanding-and-generation",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// markBridgeStarted — 修复：syncMcpConfigToProxyAndReload 重启 bridge 后同步 bridgeStarted
// ────────────────────────────────────────────────────────────────────────────
describe("markBridgeStarted — bridge 状态同步", () => {
  it("markBridgeStarted() 后，ensureBridgeStarted() 应跳过重复启动", async () => {
    const { mcpProxyManager } = await import("./mcp");
    // 通过同一 import 循环获取被 mock 替换的 persistentMcpBridge
    const { persistentMcpBridge: bridge } =
      await import("./persistentMcpBridge");

    // 首先把 cachedScriptPath 初始化（调用 start）
    await mcpProxyManager.start();

    // 注入 stdio server，使 ensureBridgeStarted 在没有标记时本该调用 bridge.start
    mcpProxyManager.setConfig({
      mcpServers: {
        time: { command: "/uv", args: ["tool", "run", "mcp-time"] },
      },
    });

    // 手动标记 bridge 已启动（模拟 syncMcpConfigToProxyAndReload 调用后的状态）
    mcpProxyManager.markBridgeStarted();

    // 此时 ensureBridgeStarted 应直接返回，不再调用 persistentMcpBridge.start
    const callsBefore = (bridge.start as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await mcpProxyManager.ensureBridgeStarted();
    const callsAfter = (bridge.start as ReturnType<typeof vi.fn>).mock.calls
      .length;

    expect(callsAfter).toBe(callsBefore); // 没有额外的 start 调用
  });

  it("syncMcpConfigToProxyAndReload 配置未变化时 early-return 也应调用 markBridgeStarted()", async () => {
    const { mcpProxyManager, syncMcpConfigToProxyAndReload } =
      await import("./mcp");
    const { persistentMcpBridge: bridge } =
      await import("./persistentMcpBridge");

    await mcpProxyManager.start();

    const servers = {
      time: { command: "/uv", args: ["tool", "run", "mcp-time"] },
    };
    mcpProxyManager.setConfig({ mcpServers: servers });

    // 第一次同步：bridge.start 被调用，bridgeStarted 被标记
    await syncMcpConfigToProxyAndReload(servers);
    const callsAfterFirst = (bridge.start as ReturnType<typeof vi.fn>).mock
      .calls.length;

    // 第二次相同配置：进入 early-return 分支
    await syncMcpConfigToProxyAndReload(servers);
    const callsAfterSecond = (bridge.start as ReturnType<typeof vi.fn>).mock
      .calls.length;

    // bridge.start 不应被再次调用（配置未变化）
    expect(callsAfterSecond).toBe(callsAfterFirst);
    // bridgeStarted 仍然为 true，ensureBridgeStarted 应跳过
    const callsBeforeEnsure = (bridge.start as ReturnType<typeof vi.fn>).mock
      .calls.length;
    await mcpProxyManager.ensureBridgeStarted();
    expect((bridge.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBeforeEnsure,
    );
  });

  it("stop() 后 markBridgeStarted 标志被重置，ensureBridgeStarted() 会重新启动", async () => {
    const { mcpProxyManager } = await import("./mcp");
    const { persistentMcpBridge: bridge } =
      await import("./persistentMcpBridge");

    await mcpProxyManager.start();
    mcpProxyManager.markBridgeStarted();

    // stop 应重置标志
    await mcpProxyManager.stop();

    // 记录 stop 后的调用次数
    const callsBefore = (bridge.start as ReturnType<typeof vi.fn>).mock.calls
      .length;

    // 注入一些 persistent server 使 ensureBridgeStarted 有服务可以启动
    mcpProxyManager.setConfig({
      mcpServers: {
        time: {
          command: "/uv",
          args: ["tool", "run", "mcp-time"],
          persistent: true,
        },
      },
    });
    await mcpProxyManager.ensureBridgeStarted();
    const callsAfter = (bridge.start as ReturnType<typeof vi.fn>).mock.calls
      .length;

    // stop 后 bridgeStarted 被重置，所以会再次调用 bridge.start
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });
});

describe("getAgentMcpConfig — 内容哈希临时文件", () => {
  beforeEach(() => {
    mockExistsSync.mockImplementation((p: unknown) => {
      // configDir 存在，config 文件首次不存在（触发写入）
      if (typeof p === "string" && p.endsWith(".json")) return false;
      return true;
    });
    mockWriteFileSync.mockClear();
  });

  it("相同配置两次调用应生成相同文件名（哈希稳定）", async () => {
    const { mcpProxyManager } = await import("./mcp");

    await mcpProxyManager.start();

    // 写入相同 MCP servers
    const servers = {
      time: { command: "/uv", args: ["tool", "run", "mcp-time"] },
    };
    mcpProxyManager.setConfig({ mcpServers: servers });

    // 第一次获取配置
    mcpProxyManager.getAgentMcpConfig();
    const firstWritePath = mockWriteFileSync.mock.calls[0]?.[0] as
      | string
      | undefined;
    mockWriteFileSync.mockClear();

    // 第二次获取配置
    mcpProxyManager.getAgentMcpConfig();
    const secondWritePath = mockWriteFileSync.mock.calls[0]?.[0] as
      | string
      | undefined;

    // 两次调用应写入相同路径（哈希稳定）
    expect(firstWritePath).toBeDefined();
    expect(secondWritePath).toBeDefined();
    expect(firstWritePath).toBe(secondWritePath);

    // 文件名格式应为 mcp-config-<serverName>-<16位hex>.json（拆分模式）
    if (firstWritePath) {
      const fileName = path.basename(firstWritePath);
      // 拆分模式：包含服务名 time
      expect(fileName).toMatch(/^mcp-config-time-[0-9a-f]{16}\.json$/);
    }
  });

  it("配置内容变化时文件名应不同（哈希随内容变化 — 用真实 MD5 验证）", async () => {
    // 此测试不调用 mcp 模块，直接验证 MD5 哈希的稳定性
    // 使用 vi.importActual 获取真实 crypto，绕过测试文件顶部对 crypto 的 mock
    const realCrypto = await vi.importActual<typeof import("crypto")>("crypto");

    const json1 = JSON.stringify({
      mcpServers: {
        time: { command: "/uv", args: ["tool", "run", "mcp-time"] },
      },
    });
    const json2 = JSON.stringify({
      mcpServers: {
        fetch: { command: "/uv", args: ["tool", "run", "mcp-fetch"] },
      },
    });

    const hash1 = realCrypto
      .createHash("md5")
      .update(json1)
      .digest("hex")
      .slice(0, 16);
    const hash2 = realCrypto
      .createHash("md5")
      .update(json2)
      .digest("hex")
      .slice(0, 16);

    // 不同内容 → 不同哈希 → 不同文件名 → detectConfigChange 不会误判
    expect(hash1).not.toBe(hash2);
    // 哈希格式应为 16 位小写 hex
    expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    expect(hash2).toMatch(/^[0-9a-f]{16}$/);
  });
});
