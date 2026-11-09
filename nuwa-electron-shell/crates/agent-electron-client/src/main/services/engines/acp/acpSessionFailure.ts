/**
 * 读取 ACP prompt 结果里的 `_meta.codex.sessionFailure`。
 *
 * nuwax-harness（codex fork）在上下文无法压缩时会把这个信号挂在
 * `session/prompt` 的返回值上，供不认识 ACP typed session failure 的客户端
 * （我们当前就是）编程处理：`actions` 里出现 `new_session` 表示该会话的
 * 历史已经无法继续压缩，继续在同一会话里提问只会重复失败。
 *
 * 形状（见 fork-codex-acp-ts `CodexEventHandler.legacyContextExhaustionMeta`）：
 *   { codex: { sessionFailure: { category, actions, message } } }
 */
export interface AcpSessionFailureSignal {
  /** 机器判据：`context_exhausted` / `input_too_large`；旧适配器可能没有。 */
  kind?: string;
  category: string;
  actions: string[];
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从 prompt 结果的 `_meta` 中取出会话失败信号；没有则返回 null。 */
export function readSessionFailureMeta(
  meta: unknown,
): AcpSessionFailureSignal | null {
  const codex = asRecord(asRecord(meta)?.codex);
  const failure = asRecord(codex?.sessionFailure);
  if (!failure) return null;
  const kind = typeof failure.kind === "string" ? failure.kind : undefined;
  const category =
    typeof failure.category === "string" ? failure.category : "unknown";
  const actions = Array.isArray(failure.actions)
    ? failure.actions.filter((action): action is string => typeof action === "string")
    : [];
  const message =
    typeof failure.message === "string" ? failure.message : undefined;
  return { kind, category, actions, message };
}

/** 失败是否要求客户端换一个新会话（而不是重试同一会话）。 */
export function requestsNewSession(signal: AcpSessionFailureSignal): boolean {
  return signal.actions.includes("new_session");
}

/**
 * 这一轮是否应以失败结束。
 *
 * 两种判据都代表"这一轮没有正常完成"，但都**不**意味着要换会话：
 * - `context_exhausted`：harness 已保留对话并裁剪/摘要，用户可以重试或换更大窗口的模型；
 * - `input_too_large`：本次输入本身装不进窗口，缩短输入或换更大窗口的模型。
 * 会话本身始终保留，用户可以在同一个会话里继续换模型使用。
 */
export function shouldFailTurn(signal: AcpSessionFailureSignal): boolean {
  if (signal.kind !== undefined) {
    return signal.kind === "context_exhausted" || signal.kind === "input_too_large";
  }
  // Older adapters only sent category/actions.
  return signal.category === "request" || signal.actions.includes("new_session");
}
