/**
 * 桌面特性宿主端口实现（registry 之外的宿主代码）：
 * - 本地 MCP 条目：读改写 `mcp_local_config`（形状与 guiMcpLocalConfig 先例一致），
 *   写后同步 MCP Proxy；Proxy 未起（如未登录态）时同步失败可容忍，条目已落库。
 * - 随包 Node 运行时定位。
 */
import log from "electron-log";
import { getDb } from "../db";
import { getNodeBinPathWithFallback } from "./system/binaryLocator";
import type { FeatureMcpServerEntry } from "../features";
import type { McpServerEntry } from "./packages/mcp";

const MCP_LOCAL_CONFIG_KEY = "mcp_local_config";

interface McpLocalConfig {
  mcpServers: Record<string, McpServerEntry>;
}

function readMcpLocalConfig(): McpLocalConfig {
  const db = getDb();
  if (!db) return { mcpServers: {} };
  const saved = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(MCP_LOCAL_CONFIG_KEY) as { value: string } | undefined;
  if (!saved?.value) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(saved.value) as { mcpServers?: Record<string, McpServerEntry> };
    return {
      mcpServers:
        parsed?.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {},
    };
  } catch (e) {
    log.warn("[Features] Failed to parse mcp_local_config, reset:", e);
    return { mcpServers: {} };
  }
}

export function createFeatureAgentHost() {
  return {
    /** 登记（entry）或移除（null）本地 MCP 条目并同步 MCP Proxy。 */
    async setLocalMcpServer(id: string, entry: FeatureMcpServerEntry | null): Promise<void> {
      const db = getDb();
      if (!db) {
        if (entry) throw new Error("databaseNotReady");
        log.warn("[Features] Database not ready, skip MCP removal", id);
        return;
      }
      const config = readMcpLocalConfig();
      const servers = { ...(config.mcpServers ?? {}) };
      if (entry) servers[id] = entry;
      else delete servers[id];
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
        MCP_LOCAL_CONFIG_KEY,
        JSON.stringify({ ...config, mcpServers: servers }),
      );
      try {
        const { syncMcpConfigToProxyAndReload } = await import("./packages/mcp");
        const { filterEnabledMcpServers } = await import("./utils/mcpServerMerge");
        await syncMcpConfigToProxyAndReload(filterEnabledMcpServers(servers));
      } catch (e) {
        // Proxy 未起时同步失败可容忍：条目已落库，引擎启动仍会读到
        log.warn("[Features] MCP proxy sync skipped:", e);
      }
      log.info(`[Features] MCP entry ${id}: ${entry ? "registered" : "removed"}`);
    },
    hasLocalMcpServer(id: string): boolean {
      return !!readMcpLocalConfig().mcpServers?.[id];
    },
    resolveNodeBinary: (): string | null => getNodeBinPathWithFallback(),
  };
}
