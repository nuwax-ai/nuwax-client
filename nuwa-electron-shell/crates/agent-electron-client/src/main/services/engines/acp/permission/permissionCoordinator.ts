/**
 * AcpPermissionCoordinator — ACP 工具权限决策协调器
 *
 * 持有权限相关的会话级状态（生效模式、tool_approval_rules），
 * 并按固定顺序执行决策链（对齐 rcoder tool-approval-rules-spec §7；危险命令不在此处理）：
 * ① question 类型直接拒绝（客户端专有）
 * ② tool_approval_rules 匹配（deny / allow / ask）
 * ③ agent_mode 默认行为（yolo 自动放行；其余返回 "ask"）
 *
 * 危险命令不单独拦截；如需对 rm 等强制审批，由 tool_approval_rules 配置（如 `rm -rf * → ask`）。
 *
 * 决策结果由调用方（AcpEngine）翻译成 ACP 响应；"ask" 结果走
 * approvalInterventionService 人工审批，该衔接保留在 AcpEngine。
 */

import log from "electron-log";
import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPermissionOption,
} from "../acpClient";
import type {
  ToolApprovalRule,
  ToolApprovalRuleInput,
} from "@shared/types/computerTypes";
import type { AcpMode } from "@shared/types/acpMode";
import {
  matchToolApprovalRules,
  normalizeToolApprovalRules,
} from "./toolApprovalRules";

/** 决策链的产出，由 AcpEngine 翻译为 ACP 响应 */
export type PermissionDecision =
  | { kind: "cancel"; reason: string }
  | { kind: "select"; optionId: string; reason: string }
  | { kind: "ask" };

export class AcpPermissionCoordinator {
  /**
   * @deprecated 遗留审批路径，当前为 dead code。
   *
   * 真实审批走 approvalInterventionService（intervention:respond IPC），
   * 此 Map 从未被写入（无 .set() 调用）。
   *
   * respondPermission 是 preload → `agent:respondPermission` IPC 暴露的 API，
   * renderer 侧无调用方。保留此 Map 及 respond()/cancelAllPending() 仅因
   * preload API 不可删除；后续可安全清理整个遗留路径。
   */
  private pendingPermissions = new Map<
    string,
    {
      resolve: (r: AcpPermissionResponse) => void;
      options: AcpPermissionOption[];
    }
  >();
  /** 会话生效模式，key 为 acpSessionId */
  private effectiveModes = new Map<string, AcpMode>();
  /** tool_approval_rules 按 acpSessionId 存储，每次 chat 请求刷新 */
  private sessionToolApprovalRules = new Map<string, ToolApprovalRule[]>();
  constructor(private readonly logTag: string) {}

  // === 会话级状态维护 ===

  setEffectiveMode(acpSessionId: string, mode: AcpMode): void {
    this.effectiveModes.set(acpSessionId, mode);
  }

  getEffectiveMode(acpSessionId: string): AcpMode {
    return this.effectiveModes.get(acpSessionId) ?? "yolo";
  }

  /** 每次 chat 请求刷新该会话的 tool_approval_rules（不传则清除，保持向后兼容） */
  setSessionApprovalRules(
    acpSessionId: string,
    rules: ToolApprovalRuleInput[] | undefined,
  ): void {
    const normalized = normalizeToolApprovalRules(rules);
    if (normalized && normalized.length > 0) {
      this.sessionToolApprovalRules.set(acpSessionId, normalized);
    } else {
      this.sessionToolApprovalRules.delete(acpSessionId);
    }
  }

  /** 会话取消/结束时清除其权限状态 */
  clearSession(acpSessionId: string): void {
    this.effectiveModes.delete(acpSessionId);
    this.sessionToolApprovalRules.delete(acpSessionId);
  }

  // === 决策链 ===

  evaluate(params: AcpPermissionRequest): PermissionDecision {
    const acpSessionId = params.sessionId;

    // ① question 类型直接拒绝
    if (params.toolCall.kind === "question") {
      log.info(
        `${this.logTag} 🚫 Denying question-type request: tool=${params.toolCall.title}`,
      );
      return { kind: "cancel", reason: "question_request" };
    }

    // ② tool_approval_rules 匹配（优先级高于 agent_mode 默认行为）
    const rules = this.sessionToolApprovalRules.get(acpSessionId);
    const ruleAction =
      rules && rules.length > 0 ? matchToolApprovalRules(params, rules) : null;

    if (ruleAction === "deny") {
      log.info(
        `${this.logTag} 🚫 Permission denied by tool_approval_rules: tool=${params.toolCall.title}`,
      );
      return { kind: "cancel", reason: "tool_approval_rules_deny" };
    }

    if (ruleAction === "allow") {
      const selected =
        params.options.find((o) => o.kind === "allow_always") ||
        params.options.find((o) => o.kind === "allow_once") ||
        params.options[0];
      if (selected) {
        log.info(
          `${this.logTag} 🔓 Permission auto-allowed by tool_approval_rules: tool=${params.toolCall.title}`,
        );
        return {
          kind: "select",
          optionId: selected.optionId,
          reason: "tool_approval_rules_allow",
        };
      }
      // 无可选项时与历史行为一致：继续走 ③ 的默认分支
    }

    // ③ agent_mode 默认行为
    const effectiveMode = this.getEffectiveMode(acpSessionId);

    // ruleAction === "ask" 时强制走审批流程，忽略 yolo 默认放行
    if (effectiveMode === "yolo" && ruleAction !== "ask") {
      const selected =
        params.options.find((o) => o.kind === "allow_always") ||
        params.options.find((o) => o.kind === "allow_once") ||
        params.options[0];

      if (selected) {
        if (
          selected.kind !== "allow_always" &&
          selected.kind !== "allow_once"
        ) {
          log.warn(`${this.logTag} yolo fallback selected non-allow option`, {
            kind: selected.kind,
            optionId: selected.optionId,
            toolTitle: params.toolCall.title,
          });
        }
        log.info(
          `${this.logTag} Permission auto-approved (yolo): tool=${params.toolCall.title}, kind=${selected.kind}, optionId=${selected.optionId}`,
        );
        return {
          kind: "select",
          optionId: selected.optionId,
          reason: "yolo_auto_approve",
        };
      }

      log.warn(
        `${this.logTag} ⚠️ No selectable options; cancelling: tool=${params.toolCall.title}`,
      );
      return { kind: "cancel", reason: "no_selectable_options" };
    }

    return { kind: "ask" };
  }

  // === 遗留审批响应路径（IPC agent:respondPermission） ===

  respond(permissionId: string, response: "once" | "always" | "reject"): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      log.warn(`${this.logTag} No pending permission for:`, permissionId);
      return;
    }

    if (response === "reject") {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    } else {
      const targetKind = response === "always" ? "allow_always" : "allow_once";
      const optionId =
        pending.options.find((o) => o.kind === targetKind)?.optionId ??
        pending.options[0]?.optionId;
      if (!optionId) {
        log.warn(
          `${this.logTag} No valid option for permission response, cancelling`,
        );
        pending.resolve({ outcome: { outcome: "cancelled" } });
      } else {
        pending.resolve({
          outcome: { outcome: "selected", optionId },
        });
      }
    }
  }

  // === 生命周期 ===

  /** destroy 开始时先 cancel 所有遗留 pending（不动会话模式状态） */
  cancelAllPending(): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.delete(id);
    }
  }

  /**
   * 引擎销毁收尾时清空全部状态。
   * 注意：必须在 destroy 的所有 await（进程清理等）之后调用——
   * 提前清空 effectiveModes 会让清理窗口期内到达的权限请求
   * 回落到默认 yolo 而被错误放行。
   */
  destroy(): void {
    this.cancelAllPending();
    this.effectiveModes.clear();
    this.sessionToolApprovalRules.clear();
  }
}
