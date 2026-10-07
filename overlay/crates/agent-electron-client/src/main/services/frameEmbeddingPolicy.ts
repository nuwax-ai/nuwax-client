import type { App, OnHeadersReceivedListenerDetails, Session } from "electron";

type ResponseHeaders = NonNullable<OnHeadersReceivedListenerDetails["responseHeaders"]>;
type ResponseHeaderDetails = Pick<
  OnHeadersReceivedListenerDetails,
  "url" | "resourceType" | "responseHeaders"
>;

interface ResponseHeaderPolicyOptions {
  allowFrameEmbedding: boolean;
  fixDevCors: boolean;
}

const installedSessions = new WeakSet<Session>();
const initializedApps = new WeakSet<App>();

/** 逗号分隔的每个 CSP 策略均独立生效，必须逐个删除防嵌入指令。 */
function removeFrameAncestors(value: string): string {
  let changed = false;
  const policies = value.split(",").map((policy) => {
    const directives = policy.split(";");
    const remaining = directives.filter(
      (directive) => !/^\s*frame-ancestors(?:\s|$)/i.test(directive),
    );
    if (remaining.length === directives.length) return policy;
    changed = true;
    const result = remaining.join(";");
    return /^[\s;]*$/.test(result) ? "" : result;
  });
  if (!changed) return value;
  return policies.filter((policy) => policy.trim() !== "").join(",");
}

/** 仅在实际修改时返回头；保留未修改头及 Set-Cookie 的原始数组。 */
export function rewriteResponseHeaders(
  details: ResponseHeaderDetails,
  options: ResponseHeaderPolicyOptions,
): ResponseHeaders | undefined {
  const original = details.responseHeaders;
  if (!original) return undefined;

  const allowFrameEmbedding =
    options.allowFrameEmbedding &&
    /^https?:\/\//i.test(details.url) &&
    (details.resourceType === "mainFrame" || details.resourceType === "subFrame");
  let modified: ResponseHeaders | undefined;
  const writable = () => (modified ??= { ...original });

  for (const [key, values] of Object.entries(original)) {
    const name = key.toLowerCase();
    if (allowFrameEmbedding && name === "x-frame-options") {
      delete writable()[key];
      continue;
    }
    if (
      allowFrameEmbedding &&
      (name === "content-security-policy" ||
        name === "content-security-policy-report-only")
    ) {
      const rewritten = values.map(removeFrameAncestors);
      if (rewritten.some((value, index) => value !== values[index])) {
        const remaining = rewritten.filter((value) => value.trim() !== "");
        if (remaining.length) writable()[key] = remaining;
        else delete writable()[key];
      }
      continue;
    }
    if (
      options.fixDevCors &&
      name === "access-control-allow-origin" &&
      values.length > 1
    ) {
      // 保留原开发行为：重复值中优先取明确来源，全部为 * 时取 *。
      writable()[key] = [values.find((value) => value !== "*") || "*"];
    }
  }
  return modified;
}

/** 商业所有会话共用一个响应头监听器；社区仅保留默认会话的开发 CORS 修复。 */
export function initFrameEmbeddingPolicy(options: {
  app: App;
  defaultSession: Session;
  isCommercial: boolean;
  isDev: boolean;
}): void {
  const { app, defaultSession, isCommercial, isDev } = options;
  if ((!isCommercial && !isDev) || initializedApps.has(app)) return;
  initializedApps.add(app);

  const install = (target: Session) => {
    const fixDevCors = isDev && target === defaultSession;
    if ((!isCommercial && !fixDevCors) || installedSessions.has(target)) return;
    installedSessions.add(target);
    target.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = rewriteResponseHeaders(details, {
        allowFrameEmbedding: isCommercial,
        fixDevCors,
      });
      // 不回写未变化的头，避免影响 Chromium 原本的 Cookie 入库路径。
      callback(responseHeaders ? { responseHeaders } : {});
    });
  };

  install(defaultSession);
  if (isCommercial) app.on("session-created", install);
}
