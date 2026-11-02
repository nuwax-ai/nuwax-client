import { describe, it, expect } from "vitest";
import {
  applyOpencodeWindowsShellConfig,
  buildOpencodeSpawnConfig,
  buildOpencodeMcpSection,
  DEFAULT_OPENCODE_PERMISSION_JSON,
  resolveOpencodePermissionEnv,
  resolveOpencodeWindowsShellPath,
} from "./opencodeSpawnConfig";

describe("opencodeSpawnConfig", () => {
  it("buildOpencodeMcpSection maps stdio and http servers", () => {
    const mcp = buildOpencodeMcpSection({
      local: { command: "node", args: ["a.js"], env: { FOO: "1" } },
      remote: { url: "http://localhost/mcp", type: "sse" },
    });
    expect(mcp).toMatchObject({
      local: {
        type: "local",
        command: ["node", "a.js"],
        environment: { FOO: "1" },
      },
      remote: { type: "sse", url: "http://localhost/mcp" },
    });
  });

  it("buildOpencodeSpawnConfig routes mutable tools through ACP permission requests", () => {
    const { configObj } = buildOpencodeSpawnConfig({
      workspaceDir: "/ws",
    });
    expect(configObj.permission).toMatchObject({
      bash: "ask",
      edit: "ask",
      webfetch: "ask",
      external_directory: "ask",
      doom_loop: "ask",
      question: "deny",
    });
  });

  it("buildOpencodeSpawnConfig 不再自动注入 MCP ask（由 nuwaxcode 或请求 OPENCODE_PERMISSION 负责）", () => {
    const { configObj } = buildOpencodeSpawnConfig({
      workspaceDir: "/ws",
      mcpServers: {
        astock: { command: "node", args: ["srv.js"] },
      },
    });
    const perm = configObj.permission as Record<string, string>;
    expect(perm["astock_*"]).toBeUndefined();
    expect(perm.bash).toBe("ask");
  });

  it("buildOpencodeSpawnConfig bridges tool_approval_rules ask patterns into permission", () => {
    const { configObj } = buildOpencodeSpawnConfig({
      workspaceDir: "/ws",
      toolApprovalRules: [
        { patterns: ["*get_stock_data"], action: "ask" },
        { patterns: ["rm *"], action: "ask", tool_kind: "execute" },
      ],
    });
    const perm = configObj.permission as Record<
      string,
      string | Record<string, string>
    >;
    expect(perm["*get_stock_data"]).toBe("ask");
    expect(perm.bash).toMatchObject({ "rm *": "ask" });
  });

  it("resolveOpencodeWindowsShellPath returns path only on Windows", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (process.platform === "win32") {
      expect(resolveOpencodeWindowsShellPath(bash)).toBe(bash);
      expect(resolveOpencodeWindowsShellPath("  ")).toBeUndefined();
    } else {
      expect(resolveOpencodeWindowsShellPath(bash)).toBeUndefined();
    }
  });

  it("buildOpencodeSpawnConfig injects Git Bash shell without sandbox", () => {
    const bash = "C:\\tools\\Git\\bin\\bash.exe";
    if (process.platform !== "win32") {
      const { configObj } = buildOpencodeSpawnConfig({
        workspaceDir: "/ws",
        gitBashPath: bash,
      });
      expect(configObj.shell).toBeUndefined();
      return;
    }
    const { configObj } = buildOpencodeSpawnConfig({
      workspaceDir: "/ws",
      gitBashPath: bash,
    });
    expect(configObj.shell).toBe(bash);
  });

  it("applyOpencodeWindowsShellConfig is no-op when path missing", () => {
    const configObj: Record<string, unknown> = {};
    expect(applyOpencodeWindowsShellConfig(configObj)).toBe(false);
    expect(configObj.shell).toBeUndefined();
  });

  it("resolveOpencodePermissionEnv 使用代码默认或 chat 入参", () => {
    expect(resolveOpencodePermissionEnv(undefined)).toBe(
      DEFAULT_OPENCODE_PERMISSION_JSON,
    );
    expect(resolveOpencodePermissionEnv("  ")).toBe(
      DEFAULT_OPENCODE_PERMISSION_JSON,
    );
    const custom = '{"bash":"deny"}';
    expect(resolveOpencodePermissionEnv(custom)).toBe(custom);
  });
});
