/**
 * MCP Helper Utilities
 *
 * Pure functions for preparing and comparing MCP server configuration.
 * No Electron or side-effectful dependencies — safe to import anywhere,
 * including test files without additional mocks.
 */

import * as path from "path";
import type { McpServerEntry } from "./mcp";

const PLATFORM_MCP_VARIABLES = [
  "SYS_USER_ID",
  "SYS_USER_UID",
  "AGENT_ID",
] as const;

/** Expand supported fields in one pass using the supplied variables. */
export function resolveMcpTemplates(
  entry: McpServerEntry,
  env?: Readonly<Record<string, string>>,
): McpServerEntry {
  const variables = env ?? {};
  const expand = (value: string) => {
    if (typeof value !== "string") return value;
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?\}/g,
      (match, name: string, fallback?: string) => {
        const configured = Object.hasOwn(variables, name)
          ? variables[name]
          : undefined;
        if (
          typeof configured === "string" &&
          configured !== match &&
          (configured !== "" || fallback === undefined)
        ) {
          return configured;
        }
        return fallback ?? match;
      },
    );
  };
  const expandValues = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, expand(value)]),
    );

  if ("url" in entry) {
    return {
      ...entry,
      ...(entry.headers && { headers: expandValues(entry.headers) }),
      ...(typeof entry.authToken === "string" && {
        authToken: expand(entry.authToken),
      }),
    };
  }

  return {
    ...entry,
    ...(Array.isArray(entry.args) && { args: entry.args.map(expand) }),
    ...(entry.env && { env: expandValues(entry.env) }),
  };
}

export function resolvePlatformMcpTemplates(
  servers: Record<string, McpServerEntry>,
  agentEnv?: Readonly<Record<string, string>>,
): Record<string, McpServerEntry> {
  const env: Record<string, string> = {};
  for (const name of PLATFORM_MCP_VARIABLES) {
    const value = agentEnv?.[name];
    if (typeof value === "string") env[name] = value;
  }

  return Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => [
      name,
      resolveMcpTemplates(entry, env),
    ]),
  );
}

export function resolveLocalMcpTemplates(
  servers: Record<string, McpServerEntry>,
): Record<string, McpServerEntry> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => [
      name,
      resolveMcpTemplates(entry, entry.env),
    ]),
  );
}

/**
 * 从 MCP server 配置中过滤掉 bridge 聚合入口
 * （command 为 "mcp-proxy" 或其绝对路径形式）。
 *
 * 用于 detectConfigChange 和 engineRawMcpServers 的原始格式快照存储。
 */
export function filterBridgeEntries(
  servers: Record<string, McpServerEntry>,
): Record<string, McpServerEntry> {
  const result: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (
      "command" in entry &&
      (entry.command === "mcp-proxy" ||
        path.basename(entry.command) === "mcp-proxy")
    )
      continue;
    result[name] = entry;
  }
  return result;
}

function sameStringValues(
  a?: Record<string, string>,
  b?: Record<string, string>,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([name, value]) => Object.hasOwn(right, name) && right[name] === value,
    )
  );
}

/**
 * 比较两组原始 MCP server 配置是否语义等价。
 *
 * 比较 stdio 启动配置和远程连接配置。stdio 的基础环境由 getAppEnv() 注入。
 *
 * @param a 本次请求传入的原始 MCP servers（已过滤掉 mcp-proxy 入口）
 * @param b 上次存储的原始 MCP servers；undefined 表示首次（无历史快照）
 */
export function rawMcpServersEqual(
  a: Record<string, McpServerEntry>,
  b: Record<string, McpServerEntry> | undefined,
): boolean {
  // 首次请求（无历史快照 b 为 undefined）且本次也没有 MCP，等价 → 不触发重建。
  // 修复：当 storedRawMcp 未建立时直接判 mcpChanged=true 会让"无任何变化"的请求也走冷启动。
  if (!b) {
    return Object.keys(a).length === 0;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.join("\0") !== bKeys.join("\0")) return false;
  for (const key of aKeys) {
    const ea = a[key];
    const eb = b[key];
    if ("url" in ea || "url" in eb) {
      if (!("url" in ea) || !("url" in eb)) return false;
      if (
        ea.url !== eb.url ||
        ea.transport !== eb.transport ||
        ea.authToken !== eb.authToken ||
        !sameStringValues(ea.headers, eb.headers)
      ) {
        return false;
      }
    } else {
      if (!("command" in ea) || !("command" in eb) || ea.command !== eb.command)
        return false;
      if (
        !sameStringValues(ea.env, eb.env) ||
        !!ea.persistent !== !!eb.persistent
      )
        return false;
      if (JSON.stringify(ea.args ?? []) !== JSON.stringify(eb.args ?? []))
        return false;
    }
    // 对数组型字段排序后比较，避免顺序差异误判
    const sortedAllowA = [...(ea.allowTools ?? [])].sort().join("\0");
    const sortedAllowB = [...(eb.allowTools ?? [])].sort().join("\0");
    if (sortedAllowA !== sortedAllowB) return false;
    const sortedDenyA = [...(ea.denyTools ?? [])].sort().join("\0");
    const sortedDenyB = [...(eb.denyTools ?? [])].sort().join("\0");
    if (sortedDenyA !== sortedDenyB) return false;
  }
  return true;
}
