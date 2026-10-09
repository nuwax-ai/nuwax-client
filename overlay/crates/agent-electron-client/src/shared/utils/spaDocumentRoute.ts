/** 客户端私有启动协议：主站 HTML 与业务 URL 分离，不向线上前端增加接口。 */
export const SPA_RESTORE_PREFIX = "#__nuwax_spa_restore=";
export const SPA_DOCUMENT_ENTRY = "/home";
export const SPA_RESTORE_ARGUMENT = "--nuwax-spa-document-restore=1";

const BUSINESS_ROOTS = ["/repo", "/instant-message"];
const NON_PAGE_ROOTS = [
  "/repo/internal", "/repo/ws", "/repo/assets", "/repo/static",
  "/instant-message/ws", "/instant-message/assets", "/instant-message/static",
];

function inRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function isMicroAppDocumentPath(pathname: string): boolean {
  // 解码只用于分类，恢复时保持原始编码；不允许编码分隔符绕过排除目录。
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return false; }
  if (/[\\\u0000-\u0020\u007f]/.test(path)) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return BUSINESS_ROOTS.some((root) => inRoot(path, root)) &&
    !NON_PAGE_ROOTS.some((root) => inRoot(path, root)) &&
    !(path.split("/").pop() || "").includes(".");
}

export function parseBusinessDocumentUrl(value: string, origin: string): URL | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
        url.origin !== origin || !isMicroAppDocumentPath(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export function buildSpaDocumentUrl(target: URL): string {
  const path = target.pathname + target.search + target.hash;
  return `${target.origin}${SPA_DOCUMENT_ENTRY}${SPA_RESTORE_PREFIX}${encodeURIComponent(path)}`;
}

/** 仅 /home 上的私有标记可恢复；标记解码一次，业务 query/hash 原样保留。 */
export function resolveSpaDocumentRestore(href: string): string | null {
  try {
    const entry = new URL(href);
    if (!/^https?:$/.test(entry.protocol) || entry.username || entry.password ||
        entry.pathname !== SPA_DOCUMENT_ENTRY || entry.search ||
        !entry.hash.startsWith(SPA_RESTORE_PREFIX)) return null;
    const path = decodeURIComponent(entry.hash.slice(SPA_RESTORE_PREFIX.length));
    if (!/^\/(?!\/)/.test(path) || /[\\\u0000-\u0020\u007f]/.test(path)) return null;
    const target = parseBusinessDocumentUrl(`${entry.origin}${path}`, entry.origin);
    if (!target || target.hash.startsWith(SPA_RESTORE_PREFIX)) return null;
    return target.pathname + target.search + target.hash;
  } catch { return null; }
}
