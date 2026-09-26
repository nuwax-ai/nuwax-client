/** One interpretation of a backend ticket for both the business jar and loopback response. */
export type Ticket = {
  value: string;
  expirationDate?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  path?: string;
};

export type TicketSetCookie =
  | { kind: "other" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; ticket: Ticket; loopbackHeader: string };

export function isTicketSetCookie(header: string): boolean {
  return /^\s*ticket=/i.test(header);
}

export function parseTicketSetCookie(header: string, businessOrigin: string): TicketSetCookie {
  if (!isTicketSetCookie(header)) return { kind: "other" };
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const value = pair.slice(pair.indexOf("=") + 1);
  if ([...value].some((char) => char.charCodeAt(0) <= 32 || char === ","))
    return { kind: "invalid", reason: "invalid value" };

  const host = new URL(businessOrigin).hostname.toLowerCase();
  const ticket: Ticket = { value, path: "/", httpOnly: true };
  const loopbackAttributes: string[] = [];
  let sameSite: "Lax" | "Strict" = "Lax";
  let seenDomain = false;
  let seenMaxAge = false;
  for (const attribute of attributes) {
    if (!attribute) continue;
    const separator = attribute.indexOf("=");
    const name = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const attrValue = separator < 0 ? "" : attribute.slice(separator + 1).trim();
    if (name === "partitioned") return { kind: "invalid", reason: "Partitioned is incompatible with loopback" };
    if (name === "domain") {
      const domain = attrValue.replace(/^\./, "").toLowerCase();
      if (seenDomain || !domain || (host !== domain && !host.endsWith(`.${domain}`)))
        return { kind: "invalid", reason: "Domain does not match business host" };
      seenDomain = true;
    } else if (name === "secure") {
      ticket.secure = true;
    } else if (name === "httponly") {
      // Always set HttpOnly in both destinations, even when upstream omitted it.
    } else if (name === "path") {
      if (!attrValue.startsWith("/")) return { kind: "invalid", reason: "invalid Path" };
      ticket.path = attrValue;
    } else if (name === "samesite") {
      const mode = attrValue.toLowerCase();
      if (mode === "none") { ticket.sameSite = "no_restriction"; sameSite = "Lax"; }
      else if (mode === "strict") { ticket.sameSite = "strict"; sameSite = "Strict"; }
      else { ticket.sameSite = "lax"; sameSite = "Lax"; }
    } else if (name === "expires") {
      const seconds = Date.parse(attrValue) / 1000;
      if (!Number.isFinite(seconds)) return { kind: "invalid", reason: "invalid Expires" };
      if (!seenMaxAge) ticket.expirationDate = seconds;
      loopbackAttributes.push(`Expires=${attrValue}`);
    } else if (name === "max-age") {
      if (!/^-?\d+$/.test(attrValue)) return { kind: "invalid", reason: "invalid Max-Age" };
      const seconds = Number(attrValue);
      if (!Number.isSafeInteger(seconds)) return { kind: "invalid", reason: "invalid Max-Age" };
      ticket.expirationDate = Date.now() / 1000 + seconds;
      seenMaxAge = true;
      loopbackAttributes.push(`Max-Age=${seconds}`);
    } else {
      loopbackAttributes.push(attribute);
    }
  }
  if (ticket.secure && new URL(businessOrigin).protocol !== "https:")
    return { kind: "invalid", reason: "Secure ticket on HTTP business host" };
  return {
    kind: "valid",
    ticket,
    loopbackHeader: [pair, `Path=${ticket.path}`, ...loopbackAttributes, `SameSite=${sameSite}`, "HttpOnly"].join("; "),
  };
}
