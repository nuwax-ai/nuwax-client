/** Build ACP session MCP inputs and metadata; preserve SDK ripgrep configuration. */

import * as path from "path";
import * as fs from "fs";
import log from "electron-log";
import { getRipgrepBinPath } from "@main/services/system/dependencies";
import type { AgentConfig, AgentEngineType } from "../types";
import type { AcpMcpServer, AcpEnvVariable } from "./acpClient";
import type { McpServerEntry } from "../../packages/mcp";
import { allocateAcpMcpServerName } from "@main/services/utils/mcpServerName";
import { mergeMcpServerConfigs } from "@main/services/utils/mcpServerMerge";

export interface NewSessionMcpServerInput {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

export interface NewSessionOpts {
  title?: string;
  cwd?: string;
  mcpServers?: Record<string, NewSessionMcpServerInput>;
  systemPrompt?: string;
  requestId?: string;
}

export interface NewSessionParamsContext {
  config: AgentConfig;
  engineName: AgentEngineType;
  logTag: string;
}

export interface BuiltNewSessionParams {
  sessionCwd: string;
  mcpServers: AcpMcpServer[];
  _meta: Record<string, unknown> | undefined;
}

function toAcpMcpServer(
  name: string,
  srv: NewSessionMcpServerInput,
): AcpMcpServer {
  if ("url" in srv && srv.url) {
    return {
      name,
      url: srv.url,
      headers: [],
      type: (srv.type || "http") as "http" | "sse",
    };
  }
  // stdio 类型（降级）
  const envVars: AcpEnvVariable[] = [];
  if (srv.env) {
    for (const [k, v] of Object.entries(srv.env)) {
      envVars.push({ name: k, value: v });
    }
  }
  if (!srv.command) {
    throw new Error(
      `[toAcpMcpServer] MCP server "${name}" has no command and no valid url — skipping`,
    );
  }
  return {
    name,
    command: srv.command,
    args: srv.args || [],
    env: envVars,
  };
}

/**
 * 将 MCP server 加入 ACP 列表：规范 server 名（中文 → `_`）并去重。
 * 本地配置保留原始名；仅 ACP 下发侧替换，与 deepagents-flow-ts 消费侧规则一致。
 */
function pushAcpMcpServer(
  mcpServers: AcpMcpServer[],
  usedNames: Set<string>,
  rawName: string,
  srv: NewSessionMcpServerInput,
  logTag: string,
): void {
  const { name, sanitized } = allocateAcpMcpServerName(rawName, usedNames);
  if (sanitized) {
    log.warn(
      `${logTag} MCP server name sanitized for ACP (LLM tool name compatibility)`,
      { rawName, name },
    );
  }
  mcpServers.push(toAcpMcpServer(name, srv));
}

export function buildNewSessionParams(
  opts: NewSessionOpts | undefined,
  ctx: NewSessionParamsContext,
): BuiltNewSessionParams {
  const { config, logTag } = ctx;

  // Build mcpServers array for ACP (McpServerStdio format)
  const mcpServers: AcpMcpServer[] = [];
  const usedMcpNames = new Set<string>();

  // 在配置层合并去重：opts 仅补充 config 中不存在的 key；同 key 以 config（含本地优先结果）为准
  const mergedMcpServerRecords = mergeMcpServerConfigs(
    opts?.mcpServers as Record<string, McpServerEntry> | undefined,
    config.mcpServers,
  );

  for (const [name, srv] of Object.entries(mergedMcpServerRecords)) {
    pushAcpMcpServer(mcpServers, usedMcpNames, name, srv, logTag);
  }

  const sessionCwd = (() => {
    const raw = opts?.cwd || config.workspaceDir;
    if (path.isAbsolute(raw)) return raw;
    log.warn(`${logTag} sessionCwd is not absolute (${raw}), resolving`);
    return path.resolve(raw);
  })();

  // Build _meta with systemPrompt if provided (skip if empty or whitespace only)
  const systemPromptTrimmed = opts?.systemPrompt?.trim();
  const requestId = opts?.requestId;
  const _meta: Record<string, unknown> | undefined = (() => {
    const meta: Record<string, unknown> = {};
    if (systemPromptTrimmed) {
      meta.systemPrompt = { append: systemPromptTrimmed };
    }
    if (requestId) {
      meta.requestId = requestId;
      meta.request_id = requestId;
    }
    // Inject bundled ripgrep path into SDK sandbox config so GrepTool/GlobTool
    // can find rg without relying on PATH inheritance in child shells.
    try {
      const rgPath = getRipgrepBinPath();
      if (fs.existsSync(rgPath)) {
        const cc = (meta.claudeCode ??= {}) as Record<string, unknown>;
        const ccOpts = (cc.options ??= {}) as Record<string, unknown>;
        ccOpts.sandbox = {
          ...(ccOpts.sandbox as Record<string, unknown> | undefined),
          ripgrep: { command: rgPath },
        };
        log.info(
          `${logTag} Injected bundled ripgrep into SDK sandbox config: ${rgPath}`,
        );
      }
    } catch {
      // bundled ripgrep optional
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  })();

  return { sessionCwd, mcpServers, _meta };
}
