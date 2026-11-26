/**
 * Agent 浏览器控制的可返回错误码。
 *
 * 这些错误会原样进入 MCP 工具结果：`uncertain` 表示动作可能已经生效，模型不得自动重放；
 * 其余错误在执行前被拒绝，页面状态未被本工具改变。
 */
export type AgentBrowserErrorCode =
  | "invalidArguments"
  | "noAuthorization"
  | "reauthRequired"
  | "noPage"
  | "noWindow"
  | "unknownWindow"
  | "unknownTab"
  | "tabInactive"
  | "denied"
  | "pageBusy"
  | "pageChanged"
  | "busy"
  | "confirmationDenied"
  | "observationRequired"
  | "observationExpired"
  | "elementNotFound"
  | "elementNotVisible"
  | "invalidUrl"
  | "crossOrigin"
  | "pageLoading"
  | "pageUnavailable"
  | "navigationFailed"
  | "debuggerUnavailable"
  | "notAuthorized"
  | "cancelled"
  | "uncertain";

export class AgentBrowserError extends Error {
  constructor(
    readonly code: AgentBrowserErrorCode,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "AgentBrowserError";
  }
}

export function invalidArguments(message = "Invalid tool arguments."): AgentBrowserError {
  return new AgentBrowserError("invalidArguments", message);
}

/** Abort reasons are not user-facing; the gateway only reports the code. */
export function cancelled(message = "The browser action was cancelled."): AgentBrowserError {
  return new AgentBrowserError("cancelled", message);
}
