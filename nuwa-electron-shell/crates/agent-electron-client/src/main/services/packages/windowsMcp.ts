/** 商业版 computer use 由 CUA 提供。保留继承调用的停用接口，不加载旧资源、安装依赖或清理端口。 */
const unavailable = "Legacy GUI MCP is not available; use CUA computer use";

export async function startWindowsMcp(): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: unavailable };
}

export async function stopWindowsMcp(): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}

export function getWindowsMcpStatus(): { running: boolean; port?: number; error?: string | null } {
  return { running: false };
}

export function getWindowsMcpUrl(): string | null { return null; }
export function isWindowsMcpAvailable(): boolean { return false; }
