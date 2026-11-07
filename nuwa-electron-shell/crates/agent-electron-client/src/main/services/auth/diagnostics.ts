import { randomUUID } from "node:crypto";
import type { HostAuthClearDiagnostic } from "@shared/types/hostBridge";

function diagnosticPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 4096
  )
    return undefined;
  return value
    .split(/[?#]/, 1)[0]
    .split("/")
    .slice(0, 12)
    .map((part) =>
      !part || /^[a-zA-Z][a-zA-Z-]{0,39}$/.test(part) ? part : "*"
    )
    .join("/")
    .slice(0, 240);
}

/** IPC 页面数据只取白名单字段；不接收凭据、响应正文和自由文本错误信息。 */
export function sanitizeAuthClearDiagnostic(
  input: unknown
): HostAuthClearDiagnostic {
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    eventId:
      typeof raw.eventId === "string" &&
      /^auth-[a-z0-9]{1,16}-\d{1,10}$/.test(raw.eventId)
        ? raw.eventId
        : `shell-${randomUUID()}`,
    source:
      typeof raw.source === "string" &&
      ["web-request", "micro-app", "user-menu"].includes(raw.source)
        ? (raw.source as HostAuthClearDiagnostic["source"])
        : "unspecified",
    reason:
      typeof raw.reason === "string" &&
      ["http-401", "business-code", "auth-expired", "manual-logout"].includes(
        raw.reason
      )
        ? (raw.reason as HostAuthClearDiagnostic["reason"])
        : "unspecified",
    requestPath: diagnosticPath(raw.requestPath),
    method:
      typeof raw.method === "string" &&
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(raw.method)
        ? raw.method
        : undefined,
    status:
      typeof raw.status === "number" &&
      Number.isInteger(raw.status) &&
      raw.status >= 100 &&
      raw.status <= 599
        ? raw.status
        : undefined,
    code:
      typeof raw.code === "string" && /^(?:\d{4}|IM_\d{5})$/.test(raw.code)
        ? raw.code
        : undefined,
    microApp:
      typeof raw.microApp === "string" &&
      ["nuwax-im-web", "nuwax-repo-web"].includes(raw.microApp)
        ? raw.microApp
        : undefined,
    pagePath: diagnosticPath(raw.pagePath),
    visibility:
      typeof raw.visibility === "string" &&
      ["visible", "hidden"].includes(raw.visibility)
        ? raw.visibility
        : undefined,
    online: typeof raw.online === "boolean" ? raw.online : undefined,
  };
}
