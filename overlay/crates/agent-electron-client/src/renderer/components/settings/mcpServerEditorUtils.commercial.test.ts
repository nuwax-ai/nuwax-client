import { describe, expect, it, vi } from "vitest";
import { formatMcpServerSummary, simplifyCommandPath } from "./mcpServerEditorUtils";
import { isComputerUseManagedServerId } from "../../../shared/guiMcp";

vi.mock("../../services/core/i18n", () => ({
  t: (key: string) => key,
}));

describe("isComputerUseManagedServerId", () => {
  it("识别 cua（含大小写与空白容差）", () => {
    expect(isComputerUseManagedServerId("cua")).toBe(true);
    expect(isComputerUseManagedServerId(" CUA ")).toBe(true);
    expect(isComputerUseManagedServerId("chrome-devtools")).toBe(false);
    expect(isComputerUseManagedServerId("gui-agent")).toBe(false);
  });
});

describe("formatMcpServerSummary（商业覆盖新增）", () => {
  it("cua 条目展示固定摘要，tooltip 保留完整命令", () => {
    const entry = {
      command: "D:\\tools\\Nuwax\\resources\\node\\win32-x64\\bin\\node.exe",
      args: ["C:\\Users\\MECHREVO\\AppData\\Roaming\\Nuwax\\computer-use\\cua-stdio-relay.cjs"],
    };
    const result = formatMcpServerSummary("cua", entry);
    expect(result.display).toBe("Claw.MCP.list.cuaDisplaySummary");
    expect(result.full).toBe(`${entry.command} ${entry.args[0]}`);
  });

  it("普通条目简化长路径为基名，保留短参数", () => {
    const entry = {
      command: "/usr/local/bin/node",
      args: [
        "/very/long/path/to/server/bundle/dist/index.js",
        "--config-file",
        "cfg.json",
      ],
    };
    const result = formatMcpServerSummary("context7", entry);
    expect(result.display).toBe("node index.js --config-file cfg.json");
    expect(result.full).toBe("/usr/local/bin/node /very/long/path/to/server/bundle/dist/index.js --config-file cfg.json");
  });

  it("内联 -e 长脚本缩略为占位符", () => {
    const script = "const fs=require('node:fs');const net=require('node:net');/* long inline script */";
    const result = formatMcpServerSummary("custom", { command: "node", args: ["-e", script] });
    expect(result.display).toBe("node -e [inline script]");
  });

  it("remote 条目原样展示 url", () => {
    const result = formatMcpServerSummary("remote-svc", { url: "https://example.com/mcp" });
    expect(result).toEqual({ display: "https://example.com/mcp", full: "https://example.com/mcp" });
  });
});

describe("simplifyCommandPath", () => {
  it("取路径最后一段（兼容 Windows 分隔符）", () => {
    expect(simplifyCommandPath("D:\\tools\\Nuwax\\resources\\node.exe")).toBe("node.exe");
    expect(simplifyCommandPath("/usr/local/bin/node")).toBe("node");
    expect(simplifyCommandPath("npx")).toBe("npx");
  });
});
