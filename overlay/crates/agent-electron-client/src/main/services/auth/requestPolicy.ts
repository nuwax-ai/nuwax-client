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

export function isPublicAuthPath(pathname: string): boolean {
  return [
    "/api/user/passwordLogin",
    "/api/user/codeLogin",
    "/api/user/code/send",
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
