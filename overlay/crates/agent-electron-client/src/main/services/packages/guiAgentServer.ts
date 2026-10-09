/** 商业版 computer use 由 CUA 提供。保留继承调用的停用接口，不加载旧资源、安装依赖或清理端口。 */
const unavailable = "Legacy GUI MCP is not available; use CUA computer use";

export function getGuiMcpPort(): number { return 60008; }
export async function startGuiAgentServer(): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: unavailable };
}

export async function stopGuiAgentServer(): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}

export function getGuiAgentServerStatus(): { running: boolean; port?: number; error?: string | null } {
  return { running: false };
}

export function getGuiAgentServerUrl(): string | null { return null; }
export function isGuiAgentServerAvailable(): boolean { return false; }
