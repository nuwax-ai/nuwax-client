/**
 * ACP session primitives for chat: cwd/title derivation and session-id shape check.
 *
 * The ordered resolution for a chat request (memory → load → new, with per-stage
 * budgets, engine recycle, home quarantine and breaker) lives in
 * acpSessionRecovery.ts; cross-process restore uses session/load only.
 */

import * as path from "path";
import type { ComputerChatRequest } from "@shared/types/computerTypes";
import { resolveAgentProjectDir } from "../../workspacePaths";
import { extractNormalProjectContainerPid } from "../../computer/agentWorkDir";
import type { NewSessionOpts } from "./acpNewSessionParams";
import type { SessionWorkspaceRef } from "./acpSessionWorkspace";

/** OpenCode / nuwaxcode 会话 id 前缀 */
const OPENCODE_SESSION_ID_RE = /^ses_/i;

export type SessionRestoredVia = "memory" | "resume" | "load" | "new";

/**
 * 判断 sessionId 是否适合在当前引擎上 session/load。
 * 不兼容时必须跳过 load（直接 newSession）。
 *
 * 背景（2026-08-10 / 2026-08-11 日志）：同会话切换模型协议导致 agent engine 切换
 * （claude-code ↔ nuwaxcode）时，平台仍携带上一引擎的 sessionId 调用 session/load。
 * nuwaxcode(OpenCode) 对异引擎 UUID 会卡约 64–68s 才返回 `OpenCode service failure`。
 * 仅靠超时不够：宿主侧超时不取消底层 RPC。现在同引擎的硬超时由恢复链路处理——
 * 销毁进程后在新进程里建新会话（见 acpSessionRecovery.ts）；这里的形态校验仍先把
 * 明知不可恢复的 load 挡掉，省掉一次超时。
 *
 * Session id 形态（启发式）：
 * - OpenCode / nuwaxcode：`ses_*`
 * - Claude Code：标准 UUID
 *
 * TODO(engine-switch-session) 剩余：
 * 1) 避免 tool_approval_rules 变更触发的二次整进程 reinit
 * 2) 修正 OpenCode 不支持的 setSessionMode(ask) 映射
 *    → 已澄清：agent_mode 不走 session/set_mode，只走本地权限审批
 */
export function isSessionIdCompatibleWithEngine(
  sessionId: string,
  engineName: string,
): boolean {
  const id = sessionId.trim();
  if (!id) return false;

  const isOpenCodeSes = OPENCODE_SESSION_ID_RE.test(id);

  // nuwaxcode / OpenCode：只接受 ses_*；Claude UUID 会挂起数十秒
  if (engineName === "nuwaxcode") {
    return isOpenCodeSes;
  }

  // claude-code：拒绝明确的 OpenCode ses_*；其它形态（含 UUID）允许尝试
  if (engineName === "claude-code") {
    return !isOpenCodeSes;
  }

  // codex / 自定义等：形态未知，交给 load + 超时兜底
  return true;
}

export interface AcpSessionLike extends SessionWorkspaceRef {
  title?: string;
  createdAt: number;
  status: string;
}

export interface SessionSetupDeps {
  logTag: string;
  workspaceDir: string;
  /** 当前 ACP 引擎名（claude-code / nuwaxcode / codex…），用于跨引擎 sessionId 形态校验 */
  engineName: string;
  agentCapabilities: Record<string, unknown> | null;
  getSession(sessionId: string): AcpSessionLike | undefined;
  findSessionByProjectId(projectId: string): AcpSessionLike | null;
  loadSession(sessionId: string, opts: NewSessionOpts): Promise<AcpSessionLike>;
  createSession(opts: NewSessionOpts): Promise<{ id: string }>;
  getSessionRecord(id: string): AcpSessionLike;
}

/**
 * workDirId/projectDir 推导（三轨）：
 * - 标识符轨道：projectDir = {workspace}/computer-project-workspace/{userId}/{id}，
 *   workDirId 兼作会话 title。
 * - 绝对路径轨道（web 端工作空间选择）：projectDir = 入口归一化后的路径原值
 *   （不拼接 workspace）；title 用 basename（全路径作 title 过长）。
 * - normalProject 轨道（service_type=computer-normal-project）：projectDir =
 *   {workspace}/computer-project-workspace/{userId}/normalProject/{pid}（本机
 *   镜像云端 /home/user/normalProject/{pid} 布局）；容器物化形态归一为 pid
 *   （防御绕过 router 校验的调用方）。同一常规项目多会话 agent_work_dir 相同
 *   （devTargetId）→ 共享工作区；引擎和会话各按 conversationId 独立。
 * 会话归属 projectId 的回写不在本函数（恢复链路用 request.project_id 作会话
 * 归属，agent_work_dir 只决定 cwd）。
 */
export function buildWorkDirAndProjectDir(
  deps: Pick<SessionSetupDeps, "workspaceDir">,
  request: ComputerChatRequest,
): { workDirId: string; projectDir: string } {
  const rawWorkDirId =
    request.agent_work_dir || request.project_id || `proj-${Date.now()}`;
  // 三轨目录推导收敛到 resolveAgentProjectDir 单一事实源（与 codex workspaceDir
  // 覆盖、devcomputer reload 归档同源，防实现漂移）
  const projectDir = resolveAgentProjectDir(
    deps.workspaceDir,
    request.user_id,
    rawWorkDirId,
    request.service_type,
  );
  // title：绝对路径用 basename；normalProject 容器物化形态归一为 pid；标识符原值
  const containerPid = extractNormalProjectContainerPid(rawWorkDirId);
  const workDirId = containerPid ?? rawWorkDirId;
  return {
    workDirId: path.isAbsolute(workDirId)
      ? path.basename(workDirId)
      : workDirId,
    projectDir,
  };
}
