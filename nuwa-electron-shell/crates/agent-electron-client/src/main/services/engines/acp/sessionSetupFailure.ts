/**
 * 会话建立失败时返回给后端的信封。
 *
 * 信封沿用既有约定（code "5000" + success false，HTTP 200），只把 message 换成可读
 * 文案，并在 data 里带上 fallback_reason 供后端/前端区分。need_fallback 不动：契约里
 * 它的含义是「需要调用方降级重试」，后端行为未确认前不设置。
 */

import type {
  ComputerChatRequest,
  ComputerChatResponse,
  HttpResult,
} from "@shared/types/computerTypes";
import { t } from "../../i18n";
import { parseSetupTimeoutStage } from "./acpSetupBudgets";
import type {
  SessionSetupFailureReason,
  SessionSetupFallbackReason,
} from "./acpSessionRecovery";

/** 引擎初始化阶段可能超时的几步，与 acpEngine / acpProcess / opencodePluginShare 的措辞对应。 */
const ENGINE_INIT_TIMEOUT_STAGES: ReadonlySet<string> = new Set([
  "handshake",
  "engine spawn",
  "plugin install",
]);

/**
 * 引擎初始化阶段的超时在穿过服务层（getOrCreateEngine 把 error 包进 message）之后
 * 只剩文字：只认文案最后一段是不是这几个阶段之一的超时（措辞见 setupTimeoutMessage）。
 */
export function isEngineInitTimeoutMessage(message: string): boolean {
  const separator = message.lastIndexOf(": ");
  const tail = separator >= 0 ? message.slice(separator + 2) : message;
  const stage = parseSetupTimeoutStage(tail);
  return stage !== null && ENGINE_INIT_TIMEOUT_STAGES.has(stage);
}

/** 给用户看的文案；文案会透传到界面，必须走 i18n。 */
export function sessionSetupFailureMessage(
  reason: SessionSetupFailureReason,
  technical?: string,
): string {
  switch (reason) {
    case "engine_env_hang":
    case "quarantine_failed":
      return t("Claw.Errors.sessionSetupEnvHang");
    case "engine_init_timeout":
      return t("Claw.Errors.sessionSetupInitTimeout");
    case "setup_failed":
      // 引擎有响应但拒绝了建会话：保留技术信息，便于定位配置问题
      return technical || t("Claw.Errors.sessionSetupTimeout");
    default:
      return t("Claw.Errors.sessionSetupTimeout");
  }
}

export function buildSessionSetupFailure(
  body: ComputerChatRequest,
  reason: SessionSetupFailureReason,
  technical?: string,
): HttpResult<ComputerChatResponse> {
  const message = sessionSetupFailureMessage(reason, technical);
  return {
    code: "5000",
    message,
    data: {
      project_id: body.project_id ?? "",
      session_id: body.session_id ?? "",
      request_id: body.request_id,
      error: message,
      fallback_reason: reason,
    },
    tid: null,
    success: false,
  };
}

/** 成功但没能恢复原会话时，把原因挂到响应上（字段已在契约类型里）。 */
export function withSessionSetupFallback(
  response: ComputerChatResponse,
  fallbackReason: SessionSetupFallbackReason | undefined,
): ComputerChatResponse {
  return fallbackReason
    ? { ...response, fallback_reason: fallbackReason }
    : response;
}
