/**
 * 同会话开关 Computer Use 后的短指令（方案 A4）。
 * 下一轮 ACP prompt 注入给模型；不依赖用户手贴，也不另起 skill。
 */
export const CUA_DISABLED_NOTICE =
  "Computer Use 已关闭。请不要再调用任何桌面控制 / `cua` 相关工具；后续只使用普通对话与非桌面工具。";
export const CUA_ENABLED_NOTICE =
  "Computer Use 已重新开启。请按用法指导使用桌面工具（先观察、优先 element_index）。";

let revision = 0;
let text = "";

export function publishCuaCapabilityNotice(next: string): number {
  if (!next) return revision;
  text = next;
  return ++revision;
}

export function peekCuaCapabilityNotice(seenRevision: number): { revision: number; text: string } | null {
  if (!text || seenRevision >= revision) return null;
  return { revision, text };
}

/** 把尚未消费的开关短指令接到 prompt 前部；每会话只吃同一代一次。 */
export function applyCuaCapabilityNotice<T extends { type: string; text?: string }>(
  parts: T[],
  seenRevision: number,
): { parts: T[]; revision: number } {
  const notice = peekCuaCapabilityNotice(seenRevision);
  if (!notice) return { parts, revision: seenRevision };
  return { parts: [{ type: "text", text: notice.text } as T, ...parts], revision: notice.revision };
}

export function resetCuaCapabilityNotice(): void {
  revision = 0;
  text = "";
}
