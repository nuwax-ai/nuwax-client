/** Shared gateway/session policy; no Electron, database or IPC dependency. */
export function stripTicketCookie(cookie: string): string | undefined {
  const kept = cookie.split(";").filter((part) => {
    const separator = part.indexOf("=");
    return (
      part.slice(0, separator < 0 ? undefined : separator).trim() !== "ticket"
    );
  });
  if (kept.length === cookie.split(";").length) return cookie;
  return (
    kept
      .map((part) => part.trim())
      .filter(Boolean)
      .join("; ") || undefined
  );
}

// 仅登录签发类入口不借用旧 ticket。/api/user/code/send 不在此列：设置页「重置密码/绑定邮箱」
// 是登录态发码，后端凭 ticket 判登录并跳过验证码；剥掉会被当匿名而报「校验参数异常」，
// 匿名登录发码本无 ticket（失效 ticket 后端亦按匿名处理）。
export function isPublicAuthPath(pathname: string): boolean {
  return [
    "/api/user/passwordLogin",
    "/api/user/codeLogin",
  ].includes(pathname.replace(/\/+$/, ""));
}

/** WebSocket handshake credentials have the same origin as their HTTP counterpart. */
export function matchesBusinessOrigin(
  url: string,
  businessOrigin: string
): boolean {
  try {
    const target = new URL(url);
    if (target.username || target.password) return false;
    if (target.protocol === "ws:") target.protocol = "http:";
    if (target.protocol === "wss:") target.protocol = "https:";
    return (
      /^https?:$/.test(target.protocol) && target.origin === businessOrigin
    );
  } catch {
    return false;
  }
}

export function hasOrigin(url: string, origins: readonly string[]): boolean {
  try {
    return origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}
