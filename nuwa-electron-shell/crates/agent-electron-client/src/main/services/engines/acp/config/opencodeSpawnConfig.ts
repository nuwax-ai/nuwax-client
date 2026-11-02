/**
 * Build OPENCODE_CONFIG_CONTENT payload for OpenCode-family ACP engines.
 *
 * 注意：MCP 默认不要经本模块写入 configObj.mcp。
 * AcpEngine 已改为只通过 ACP session/new.mcpServers 下发，避免与
 * nuwaxcode Instance MCP.state + registerMcpServers 形成双路径重复建连。
 * buildOpencodeMcpSection 仍保留，供测试或显式 opt-in。
 */

import type { ToolApprovalRuleInput } from "@shared/types/computerTypes";
import { buildOpencodePermissionWithAskBridge } from "../permission/opencodePermissionBridge";

export const DEFAULT_OPENCODE_ACP_PERMISSION: Record<string, string> = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  doom_loop: "ask",
  external_directory: "ask",
  question: "deny",
};

/**
 * nuwaxcode 支持的 OPENCODE_PERMISSION 环境变量默认值（内联 JSON）。
 * 见 nuwaxcode packages/opencode/src/config/config.ts — mergeDeep 进 cfg.permission。
 *
 * chat 未传 agent_server.env.OPENCODE_PERMISSION 时使用；传了则用入参覆盖。
 * 旧版 nuwaxcode（< beta.10）临时测 MCP 审批可在请求 env 加 `"*":"ask"`。
 */
export const DEFAULT_OPENCODE_PERMISSION_ENV = {
  bash: "ask",
  edit: "ask",
  question: "deny",
} as const;

export const DEFAULT_OPENCODE_PERMISSION_JSON = JSON.stringify(
  DEFAULT_OPENCODE_PERMISSION_ENV,
);

/** 解析 spawn 用的 OPENCODE_PERMISSION 字符串（chat 入参优先，否则代码默认） */
export function resolveOpencodePermissionEnv(
  fromChatEnv?: string | null,
): string {
  const trimmed = fromChatEnv?.trim();
  return trimmed || DEFAULT_OPENCODE_PERMISSION_JSON;
}

export type AgentMcpServerEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
};

export function buildOpencodeMcpSection(
  mcpServers: Record<string, AgentMcpServerEntry> | undefined,
): Record<string, unknown> | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  const mcpConfig: Record<string, unknown> = {};
  for (const [name, srv] of Object.entries(mcpServers)) {
    if ("url" in srv && srv.url) {
      mcpConfig[name] = {
        type: srv.type === "sse" ? "sse" : "streamable-http",
        url: srv.url,
        enabled: true,
      };
    } else if ("command" in srv && srv.command) {
      mcpConfig[name] = {
        type: "local",
        command: [srv.command, ...(srv.args || [])],
        environment: srv.env || {},
        enabled: true,
      };
    }
  }
  return Object.keys(mcpConfig).length > 0 ? mcpConfig : undefined;
}

export function buildOpencodeProviderSection(
  model: string | undefined,
): Record<string, unknown> | undefined {
  if (!model) return undefined;
  const slashIdx = model.indexOf("/");
  if (slashIdx <= 0) return undefined;
  const providerID = model.substring(0, slashIdx);
  const modelID = model.substring(slashIdx + 1);
  // Infer key env var from providerID pattern (openai-compatible/anthropic-compatible
  // are special cases; dot-separated model IDs like "gpt-4o" from provider "gpt" are
  // treated as custom providers with no default env).
  const envVars: string[] =
    providerID === "openai-compatible"
      ? ["OPENAI_API_KEY"]
      : providerID === "anthropic-compatible"
        ? ["ANTHROPIC_API_KEY"]
        : [];
  return {
    [providerID]: {
      name: providerID,
      env: envVars,
      models: {
        [modelID]: { name: modelID },
      },
    },
  };
}

export type BuildOpencodeSpawnConfigOptions = {
  mcpServers?: Record<string, AgentMcpServerEntry>;
  model?: string;
  workspaceDir: string;
  /** Windows Git Bash path → OPENCODE_CONFIG_CONTENT.shell (no sandbox required). */
  gitBashPath?: string;
  /** tool_approval_rules 中 ask 规则桥接到 permission，触发引擎层 requestPermission */
  toolApprovalRules?: ToolApprovalRuleInput[];
};

/** Resolve shell path for OpenCode on Windows (bundled Git Bash from app package). */
export function resolveOpencodeWindowsShellPath(
  gitBashPath?: string | null,
): string | undefined {
  if (process.platform !== "win32") return undefined;
  const trimmed = gitBashPath?.trim();
  return trimmed || undefined;
}

/** Inject Git Bash into spawn config so nuwaxcode runs bash tool via Git Bash, not cmd. */
export function applyOpencodeWindowsShellConfig(
  configObj: Record<string, unknown>,
  gitBashPath?: string | null,
): boolean {
  const shell = resolveOpencodeWindowsShellPath(gitBashPath);
  if (!shell) return false;
  configObj.shell = shell;
  return true;
}

export type BuildOpencodeSpawnConfigResult = {
  configObj: Record<string, unknown>;
};

export function buildOpencodeSpawnConfig(
  options: BuildOpencodeSpawnConfigOptions,
): BuildOpencodeSpawnConfigResult {
  const configObj: Record<string, unknown> = {};
  const mcp = buildOpencodeMcpSection(options.mcpServers);
  if (mcp) {
    configObj.mcp = mcp;
  }
  configObj.permission = { ...DEFAULT_OPENCODE_ACP_PERMISSION };

  const provider = buildOpencodeProviderSection(options.model);
  if (provider) {
    configObj.provider = provider;
  }

  applyOpencodeWindowsShellConfig(configObj, options.gitBashPath);

  if (options.toolApprovalRules?.length) {
    configObj.permission = buildOpencodePermissionWithAskBridge(
      (configObj.permission ?? {}) as Record<
        string,
        string | Record<string, string>
      >,
      options.toolApprovalRules,
    );
  }

  return { configObj };
}
