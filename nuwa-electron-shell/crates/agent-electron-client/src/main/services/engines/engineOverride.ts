/**
 * 引擎强制覆盖 —— 测试开关背后的全部逻辑，集中于此便于将来整体移除。
 *
 * 由来：DevToolsPanel 的「Force nuwax-harness-acp-ts Engine」开关把每个请求的
 * 引擎命令改写为 nuwax-harness-acp-ts，用于在真实后端配置下验证适配器集成。
 *
 * 移除路径（测试稳定后）：
 *   1. 删本文件；
 *   2. 删 DevToolsPanel 里的 Force 开关行与「Agent Engine Testing」卡片；
 *   3. 删 SettingsPage 的 devToolsVisible 门控（含读 update_channel 的 effect），
 *      恢复为直接渲染 DevToolsPanel；
 *   4. 删 shared/constants.ts 的 DEV_FORCE_ENGINE_SETTING_KEY / DEV_FORCE_ENGINE_HARNESS。
 *
 * 不属于本模块、不要随之删除的：harness 适配器的 env 组装（NUWAX_PATH、协议族、
 * CLAUDE_CODE_DISABLE_THINKING 映射）在 acpClient 的 codex 分支，那是适配器集成
 * 的永久部分，与开关无关。
 */
import log from "electron-log";
import { readSetting } from "../../db";
import {
  DEV_FORCE_ENGINE_HARNESS,
  DEV_FORCE_ENGINE_SETTING_KEY,
} from "@shared/constants";

export { DEV_FORCE_ENGINE_HARNESS, DEV_FORCE_ENGINE_SETTING_KEY };

/** 更新通道设置键（与 services/autoUpdater.ts、renderer AboutPage 同一键） */
const UPDATE_CHANNEL_SETTING_KEY = "update_channel";

/**
 * 是否放行强制覆盖：本地开发构建，或 beta 通道包。
 *
 * 打包构建的 NODE_ENV 恒为 production（pack.mjs 注入），beta 必须按通道放行，
 * 否则 beta 用户拨了开关也不生效。stable 两个条件都不满足，一律不放行——即使
 * dev.force_engine 里留着值（用户在 beta 下开启后切到 stable）。
 */
export function isEngineOverrideAllowed(input: {
  nodeEnv: string | undefined;
  updateChannel: unknown;
}): boolean {
  return input.nodeEnv === "development" || input.updateChannel === "beta";
}

/** 强制目标命令：env NUWACLAW_FORCE_ENGINE 优先，其次开关持久化的设置值。 */
export function resolveForcedEngineSource(): string {
  const setting = readSetting(DEV_FORCE_ENGINE_SETTING_KEY);
  const fromSetting = typeof setting === "string" ? setting.trim() : "";
  return process.env.NUWACLAW_FORCE_ENGINE || fromSetting;
}

/**
 * 按需改写请求的引擎命令（绕过 agent_server.command）。
 * 返回被强制成的命令；未改写返回 null，调用方只需负责记日志。
 */
export function applyForcedEngineToRequest(request: {
  agent_config?: {
    agent_server?: { command?: string };
  } | null;
}): string | null {
  const forced = resolveForcedEngineSource();
  if (!forced) return null;
  const updateChannel = readSetting(UPDATE_CHANNEL_SETTING_KEY);
  if (
    !isEngineOverrideAllowed({
      nodeEnv: process.env.NODE_ENV,
      updateChannel,
    })
  ) {
    log.debug(
      `[EngineOverride] 设置里有强制值但当前构建不放行: channel=${String(updateChannel ?? "stable")}`,
    );
    return null;
  }
  if (!request.agent_config) {
    request.agent_config = { agent_server: { command: forced } };
  } else if (!request.agent_config.agent_server) {
    request.agent_config.agent_server = { command: forced };
  } else {
    request.agent_config.agent_server.command = forced;
  }
  log.debug(
    `[EngineOverride] forced to "${forced}" (NODE_ENV=${process.env.NODE_ENV}, channel=${String(updateChannel ?? "stable")})`,
  );
  return forced;
}
