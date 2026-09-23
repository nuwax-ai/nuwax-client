import { session, type Cookies } from "electron";
import log from "electron-log";
import { readSetting, writeSetting } from "../db";
import { currentBusinessOrigin, readTicketCookieValue, NUWAX_TICKET_KEY_PREFIX } from "./commercialSessionScope";

type Ticket = { value: string; expirationDate?: number; secure?: boolean; httpOnly?: boolean; sameSite?: "unspecified" | "no_restriction" | "lax" | "strict"; path?: string };
const key = (origin: string) => `${NUWAX_TICKET_KEY_PREFIX}${origin}`;
const metaKey = (origin: string) => `nuwax.ticketMeta.${origin}`;
const incompatibleKey = (origin: string) => `nuwax.ticketSecureHttp.${origin}`;
const COOKIE_REPLACEMENT_SETTLE_MS = 20;
let epoch = 0;
let listening = false;
let loopbackOrigin: string | null = null;

export function ticketEpoch(): number { return epoch; }
export function advanceTicketEpoch(): void { epoch++; }
export function invalidateTicketSession(origins: string[]): void {
  epoch++;
  for (const origin of origins) {
    writeSetting(key(origin), null);
    writeSetting(metaKey(origin), null);
    writeSetting(incompatibleKey(origin), null);
  }
}
export async function clearTicketCookies(origins: string[]): Promise<void> {
  const cookies = session.defaultSession.cookies;
  await Promise.all(origins.map((origin) => cookies.remove(origin, "ticket")));
}
export function currentTicket(): string | null {
  return readTicketCookieValue([currentBusinessOrigin()]);
}

function parseTicket(header: string): Ticket | null {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  if (separator < 0 || pair.slice(0, separator).toLowerCase() !== "ticket") return null;
  if (/[\x00-\x20;,]/.test(pair.slice(separator + 1))) return null;
  const ticket: Ticket = { value: pair.slice(separator + 1), path: "/", httpOnly: true };
  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.split("=");
    const name = rawName.toLowerCase();
    const value = rawValue.join("=");
    if (name === "path" && value.startsWith("/")) ticket.path = value;
    if (name === "secure") ticket.secure = true;
    if (name === "httponly") ticket.httpOnly = true;
    if (name === "samesite") {
      const mode = value.toLowerCase();
      ticket.sameSite = mode === "none" ? "no_restriction" : mode === "strict" ? "strict" : "lax";
    }
    if (name === "expires") {
      const seconds = Date.parse(value) / 1000;
      if (Number.isFinite(seconds)) ticket.expirationDate = seconds;
    }
    if (name === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) ticket.expirationDate = Date.now() / 1000 + seconds;
    }
  }
  return ticket;
}

async function put(cookies: Cookies, origin: string, ticket: Ticket): Promise<void> {
  const url = new URL(origin);
  if (ticket.secure && url.protocol !== "https:") {
    // An HTTPS-only backend cookie cannot authenticate an HTTP business host.
    log.error("[TicketSession] Secure ticket rejected for HTTP business host", { origin });
    return;
  }
  if (!ticket.value || (ticket.expirationDate !== undefined && ticket.expirationDate <= Date.now() / 1000)) {
    await cookies.remove(origin, "ticket");
    writeSetting(key(origin), null);
    writeSetting(metaKey(origin), null);
    return;
  }
  await cookies.set({ url: origin, name: "ticket", value: ticket.value, path: ticket.path || "/", httpOnly: true,
    secure: ticket.secure ?? url.protocol === "https:", sameSite: ticket.sameSite ?? "lax", expirationDate: ticket.expirationDate });
  writeSetting(key(origin), ticket.value);
  writeSetting(metaKey(origin), ticket);
}

/** The gateway supplies raw Set-Cookie headers; JS cannot observe them. */
export async function mirrorGatewaySetCookies(headers: string[], origin: string, requestEpoch: number): Promise<void> {
  if (origin !== currentBusinessOrigin() || requestEpoch !== epoch) return;
  for (const header of headers) {
    const ticket = parseTicket(header);
    if (!ticket || origin !== currentBusinessOrigin() || requestEpoch !== epoch) continue;
    const configuredHost = new URL(origin).hostname.toLowerCase();
    const domain = /(?:^|;)\s*domain=([^;]+)/i.exec(header)?.[1]?.trim().replace(/^\./, "").toLowerCase();
    if (domain && configuredHost !== domain && !configuredHost.endsWith(`.${domain}`)) continue;
    if (ticket.secure && new URL(origin).protocol === "http:") {
      writeSetting(incompatibleKey(origin), true);
      invalidateTicketSession([origin, ...(loopbackOrigin ? [loopbackOrigin] : [])]);
      // Keep the incompatibility marker after invalidation. A later backend
      // non-Secure Set-Cookie is the only way to clear this test gate.
      writeSetting(incompatibleKey(origin), true);
      continue;
    }
    writeSetting(incompatibleKey(origin), null);
    await put(session.defaultSession.cookies, origin, ticket);
    if (loopbackOrigin && requestEpoch === epoch) {
      await put(session.defaultSession.cookies, loopbackOrigin,
        { ...ticket, secure: false, sameSite: ticket.sameSite === "no_restriction" ? "lax" : ticket.sameSite });
    }
  }
}

export async function mirrorNativeResponseTicket(response: Response, origin: string, requestEpoch: number): Promise<void> {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  await mirrorGatewaySetCookies(setCookies, origin, requestEpoch);
}

export async function syncTicketFromJar(source: string, requestEpoch = epoch): Promise<boolean> {
  const origin = currentBusinessOrigin();
  if (readSetting(incompatibleKey(origin))) return false;
  const found = (await session.defaultSession.cookies.get({ url: source, name: "ticket" }))[0];
  if (requestEpoch !== epoch || origin !== currentBusinessOrigin() || !found) return false;
  // 127.0.0.1 cookies are shared by every port. Trust only a value previously
  // observed in a capability-authorized gateway Set-Cookie response.
  if (source === loopbackOrigin && found.value !== currentTicket()) return false;
  const persisted = readSetting(metaKey(origin)) as Ticket | null;
  const matching = persisted?.value === found.value ? persisted : null;
  const ticket: Ticket = { value: found.value, path: matching?.path ?? found.path,
    secure: matching?.secure ?? (source === origin ? found.secure : new URL(origin).protocol === "https:"),
    httpOnly: true, sameSite: matching?.sameSite ?? found.sameSite,
    expirationDate: matching?.expirationDate ?? found.expirationDate };
  if (source !== origin) await put(session.defaultSession.cookies, origin, ticket);
  else {
    writeSetting(key(origin), ticket.value);
    writeSetting(metaKey(origin), ticket);
  }
  if (loopbackOrigin && source !== loopbackOrigin && requestEpoch === epoch)
    {
      const existing = (await session.defaultSession.cookies.get({ url: loopbackOrigin, name: "ticket" }))[0];
      if (existing?.value !== ticket.value) await put(session.defaultSession.cookies, loopbackOrigin, { ...ticket, secure: false,
        sameSite: ticket.sameSite === "no_restriction" ? "lax" : ticket.sameSite });
    }
  return requestEpoch === epoch;
}

export async function restoreTicketSession(gatewayOrigin: string | null): Promise<void> {
  loopbackOrigin = gatewayOrigin;
  const origin = currentBusinessOrigin();
  if (readSetting("nuwax.cookieAuthMustRelogin")) {
    await session.defaultSession.cookies.remove(origin, "ticket");
    if (gatewayOrigin) await session.defaultSession.cookies.remove(gatewayOrigin, "ticket");
    writeSetting("nuwax.cookieAuthMustRelogin", null);
  }
  const existing = (await session.defaultSession.cookies.get({ url: origin, name: "ticket" }))[0];
  const value = currentTicket();
  const metadata = readSetting(metaKey(origin)) as Ticket | null;
  if (existing) await syncTicketFromJar(origin);
  else if (value) {
    await put(session.defaultSession.cookies, origin, { ...(metadata ?? {}), value, httpOnly: true });
    if (gatewayOrigin) await put(session.defaultSession.cookies, gatewayOrigin, { ...(metadata ?? {}), value, httpOnly: true, secure: false });
  }
  if (listening) return;
  listening = true;
  session.defaultSession.cookies.on("changed", (_event, cookie, cause, removed) => {
    const business = new URL(currentBusinessOrigin());
    const domain = (cookie.domain ?? "").replace(/^\./, "");
    if (cookie.name !== "ticket" ||
        (business.hostname !== domain && !business.hostname.endsWith(`.${domain}`))) return;
    if (removed) {
      // A replacement emits an overwrite removal followed by an insertion.
      // Explicit login/logout clearing has already invalidated the mirror.
      if (cause === "overwrite" || !currentTicket()) return;
      const observedEpoch = epoch;
      const expected = currentTicket();
      void (async () => {
        // Electron may report an "unknown" removal during overlapping jar
        // writes. Let the replacement settle before treating it as logout.
        await new Promise((resolve) => setTimeout(resolve, COOKIE_REPLACEMENT_SETTLE_MS));
        if (observedEpoch !== epoch || expected !== currentTicket()) return;
        const existing = (await session.defaultSession.cookies.get({ url: business.origin, name: "ticket" }))[0];
        if (existing) {
          await syncTicketFromJar(business.origin, observedEpoch);
          return;
        }
        if (cause === "unknown" && loopbackOrigin) {
          const gatewayCookie = (await session.defaultSession.cookies.get({ url: loopbackOrigin, name: "ticket" }))[0];
          if (gatewayCookie?.value === expected) {
            if (observedEpoch !== epoch || expected !== currentTicket()) return;
            const metadata = readSetting(metaKey(business.origin)) as Ticket | null;
            await put(session.defaultSession.cookies, business.origin, { ...(metadata ?? {}), value: expected!, httpOnly: true });
            return;
          }
        }
        if (observedEpoch !== epoch || expected !== currentTicket()) return;
        invalidateTicketSession([business.origin, ...(loopbackOrigin ? [loopbackOrigin] : [])]);
        if (loopbackOrigin) await session.defaultSession.cookies.remove(loopbackOrigin, "ticket");
      })().catch((error) => log.error("[TicketSession] cookie removal reconciliation failed", error));
      return;
    }
    void syncTicketFromJar(business.origin, epoch).catch((error) => log.error("[TicketSession] direct sync failed", error));
  });
}

export async function setLoopbackTicketOrigin(origin: string | null): Promise<void> {
  const previous = loopbackOrigin;
  loopbackOrigin = origin;
  if (previous && previous !== origin &&
      new URL(previous).hostname !== new URL(currentBusinessOrigin()).hostname)
    await session.defaultSession.cookies.remove(previous, "ticket");
  const value = currentTicket();
  if (origin && value) await put(session.defaultSession.cookies, origin,
    { value, httpOnly: true, secure: false });
}
