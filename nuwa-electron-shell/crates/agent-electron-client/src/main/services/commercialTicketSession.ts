import { session, type Cookies } from "electron";
import log from "electron-log";
import { readSetting, writeSetting } from "../db";
import { currentBusinessOrigin, readTicketCookieValue, NUWAX_TICKET_KEY_PREFIX } from "./commercialSessionScope";
import { parseTicketSetCookie, type Ticket } from "./ticketCookiePolicy";

const key = (origin: string) => `${NUWAX_TICKET_KEY_PREFIX}${origin}`;
const metaKey = (origin: string) => `nuwax.ticketMeta.${origin}`;
const incompatibleKey = (origin: string) => `nuwax.ticketSecureHttp.${origin}`;
const COOKIE_REPLACEMENT_SETTLE_MS = 200;
const DIRECT_SYNC_RETRY_DELAYS_MS = [0, 50, 150];
let epoch = 0;
let listening = false;
let loopbackOrigin: string | null = null;
let mirrorQueue: Promise<void> = Promise.resolve();
let directEventVersion = 0;
const unusableMirrorOrigins = new Set<string>();

function persistTicket(origin: string, ticket: Ticket): void {
  try {
    if (writeSetting(metaKey(origin), ticket) === false || writeSetting(key(origin), ticket.value) === false)
      throw new Error("ticket settings write failed");
    unusableMirrorOrigins.delete(origin);
  } catch (error) {
    unusableMirrorOrigins.add(origin);
    // Do not leave an older key paired with metadata for the new cookie.
    try { writeSetting(key(origin), null); writeSetting(metaKey(origin), null); }
    catch { /* The original failure is reported by the caller. */ }
    throw error;
  }
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const queued = mirrorQueue.then(operation);
  mirrorQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

export function ticketEpoch(): number { return epoch; }
export function advanceTicketEpoch(): void { epoch++; }
export function invalidateTicketSession(origins: string[]): void {
  epoch++;
  for (const origin of origins) {
    unusableMirrorOrigins.add(origin);
    for (const setting of [key(origin), metaKey(origin), incompatibleKey(origin)]) {
      try {
        if (writeSetting(setting, null) === false)
          log.error("[TicketSession] mirror invalidation write failed", { origin });
      } catch (error) { log.error("[TicketSession] mirror invalidation write failed", error); }
    }
  }
}
export async function clearTicketCookies(origins: string[]): Promise<void> {
  const cookies = session.defaultSession.cookies;
  await Promise.all(origins.map((origin) => cookies.remove(origin, "ticket")));
}
export function currentTicket(): string | null {
  const origin = currentBusinessOrigin();
  return unusableMirrorOrigins.has(origin) ? null : readTicketCookieValue([origin]);
}

async function put(cookies: Cookies, origin: string, ticket: Ticket, expectedEpoch?: number): Promise<void> {
  const url = new URL(origin);
  if (ticket.secure && url.protocol !== "https:") {
    // An HTTPS-only backend cookie cannot authenticate an HTTP business host.
    log.error("[TicketSession] Secure ticket rejected for HTTP business host", { origin });
    throw new Error("Secure ticket on HTTP business host");
  }
  if (!ticket.value || (ticket.expirationDate !== undefined && ticket.expirationDate <= Date.now() / 1000)) {
    unusableMirrorOrigins.add(origin);
    await cookies.remove(origin, "ticket");
    if (writeSetting(key(origin), null) === false || writeSetting(metaKey(origin), null) === false)
      throw new Error("ticket settings deletion failed");
    return;
  }
  await cookies.set({ url: origin, name: "ticket", value: ticket.value, path: ticket.path || "/", httpOnly: true,
    secure: ticket.secure ?? url.protocol === "https:", sameSite: ticket.sameSite ?? "lax", expirationDate: ticket.expirationDate });
  if (expectedEpoch !== undefined && expectedEpoch !== epoch) return;
  persistTicket(origin, ticket);
}

/** The gateway supplies raw Set-Cookie headers; JS cannot observe them. */
export function mirrorGatewaySetCookies(headers: string[], origin: string, requestEpoch: number): Promise<boolean> {
  // Cookie writes are asynchronous. Preserve response arrival order so a
  // later empty ticket cannot be followed by an older write finishing late.
  return enqueue(async () => {
    try {
      return await applyGatewaySetCookies(headers, origin, requestEpoch);
    } catch (error) {
      if (requestEpoch === epoch && origin === currentBusinessOrigin()) unusableMirrorOrigins.add(origin);
      throw error;
    }
  });
}

/** Fail closed now; queued cleanup runs after any in-flight cookie.set finishes. */
export function abortGatewayTicketMirror(origin: string): void {
  const origins = [origin, ...(loopbackOrigin ? [loopbackOrigin] : [])];
  invalidateTicketSession(origins);
  void enqueue(() => clearTicketCookies(origins)).catch((error) =>
    log.error("[TicketSession] failed to clear cookies after mirror failure", error));
}

async function applyGatewaySetCookies(headers: string[], origin: string, requestEpoch: number): Promise<boolean> {
  if (origin !== currentBusinessOrigin() || requestEpoch !== epoch) return false;
  let ticket: Ticket | undefined;
  for (const header of headers) {
    const parsed = parseTicketSetCookie(header, origin);
    if (parsed.kind === "invalid") {
      log.warn("[TicketSession] rejected backend ticket", { origin, reason: parsed.reason });
      if (parsed.reason === "Secure ticket on HTTP business host") {
        const origins = [origin, ...(loopbackOrigin ? [loopbackOrigin] : [])];
        invalidateTicketSession(origins);
        try { writeSetting(incompatibleKey(origin), true); }
        finally { await clearTicketCookies(origins); }
        return false;
      }
      continue;
    }
    if (parsed.kind === "valid") ticket = parsed.ticket;
  }
  if (!ticket || origin !== currentBusinessOrigin() || requestEpoch !== epoch) return false;
  if (!ticket.value || (ticket.expirationDate !== undefined && ticket.expirationDate <= Date.now() / 1000)) {
    // A logout/expiry response must clear both jars and the persisted mirror
    // before an older in-flight Set-Cookie can put the session back.
    const origins = [origin, ...(loopbackOrigin ? [loopbackOrigin] : [])];
    invalidateTicketSession(origins);
    await clearTicketCookies(origins);
    log.info("[TicketSession] Set-Cookie cleared ticket", { origin, loopback: !!loopbackOrigin });
    return true;
  }
  if (writeSetting(incompatibleKey(origin), null) === false)
    throw new Error("ticket compatibility settings write failed");
  await put(session.defaultSession.cookies, origin, ticket, requestEpoch);
  if (loopbackOrigin && requestEpoch === epoch) {
    await put(session.defaultSession.cookies, loopbackOrigin,
      { ...ticket, secure: false, sameSite: ticket.sameSite === "no_restriction" ? "lax" : ticket.sameSite }, requestEpoch);
  }
  if (requestEpoch !== epoch) return false;
  log.info("[TicketSession] Set-Cookie updated ticket", { origin, loopback: !!loopbackOrigin });
  return true;
}

export async function mirrorNativeResponseTicket(response: Response, origin: string, requestEpoch: number): Promise<void> {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  await mirrorGatewaySetCookies(setCookies, origin, requestEpoch);
}

export async function syncTicketFromJar(source: string, requestEpoch = epoch, eventVersion?: number): Promise<boolean> {
  const observedVersion = eventVersion ?? (!loopbackOrigin && source === currentBusinessOrigin() ? directEventVersion : undefined);
  try {
    return await enqueue(() => applySyncTicketFromJar(source, requestEpoch, observedVersion));
  } catch (error) {
    log.error("[TicketSession] cookie-to-settings sync failed", error);
    return false;
  }
}

async function applySyncTicketFromJar(source: string, requestEpoch: number, eventVersion?: number): Promise<boolean> {
  const origin = currentBusinessOrigin();
  if (readSetting(incompatibleKey(origin))) return false;
  const found = (await session.defaultSession.cookies.get({ url: source, name: "ticket" }))[0];
  if (requestEpoch !== epoch || origin !== currentBusinessOrigin() ||
      (eventVersion !== undefined && eventVersion !== directEventVersion) || !found) return false;
  // 127.0.0.1 cookies are shared by every port. Trust only a value previously
  // observed in a capability-authorized gateway Set-Cookie response.
  if (source === loopbackOrigin && found.value !== currentTicket()) return false;
  if (!found.value || (found.expirationDate !== undefined && found.expirationDate <= Date.now() / 1000)) {
    const origins = [origin, ...(loopbackOrigin ? [loopbackOrigin] : [])];
    invalidateTicketSession(origins);
    await clearTicketCookies(origins);
    log.info("[TicketSession] empty business cookie cleared mirror", { origin });
    return false;
  }
  const persisted = readSetting(metaKey(origin)) as Ticket | null;
  const matching = persisted?.value === found.value ? persisted : null;
  const ticket: Ticket = { value: found.value, path: matching?.path ?? found.path,
    secure: matching?.secure ?? (source === origin ? found.secure : new URL(origin).protocol === "https:"),
    httpOnly: true, sameSite: matching?.sameSite ?? found.sameSite,
    expirationDate: matching?.expirationDate ?? found.expirationDate };
  if (source !== origin) await put(session.defaultSession.cookies, origin, ticket, requestEpoch);
  else {
    persistTicket(origin, ticket);
  }
  if (loopbackOrigin && source !== loopbackOrigin && requestEpoch === epoch)
    {
      const existing = (await session.defaultSession.cookies.get({ url: loopbackOrigin, name: "ticket" }))[0];
      if (existing?.value !== ticket.value) await put(session.defaultSession.cookies, loopbackOrigin, { ...ticket, secure: false,
        sameSite: ticket.sameSite === "no_restriction" ? "lax" : ticket.sameSite }, requestEpoch);
    }
  return requestEpoch === epoch && (eventVersion === undefined || eventVersion === directEventVersion);
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
    const observedVersion = ++directEventVersion;
    if (removed) {
      // A replacement emits an overwrite removal followed by an insertion.
      // Explicit login/logout clearing has already invalidated the mirror.
      if (cause === "overwrite" || !currentTicket()) return;
      const observedEpoch = epoch;
      const expected = currentTicket();
      void enqueue(async () => {
        // Electron may report an "unknown" removal during overlapping jar
        // writes. A later insertion event cancels this reconciliation even if
        // Chromium has not committed the replacement cookie yet.
        // Unknown direct removals require stable absence across three reads,
        // rather than treating one short-lived empty jar as a logout.
        const rechecks = String(cause) === "unknown" && !loopbackOrigin ? 3 : 1;
        for (let attempt = 0; attempt < rechecks; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, COOKIE_REPLACEMENT_SETTLE_MS));
          if (observedVersion !== directEventVersion || observedEpoch !== epoch || expected !== currentTicket()) return;
          const existing = (await session.defaultSession.cookies.get({ url: business.origin, name: "ticket" }))[0];
          if (observedVersion !== directEventVersion || observedEpoch !== epoch) return;
          if (existing) {
            await applySyncTicketFromJar(business.origin, observedEpoch, observedVersion);
            return;
          }
        }
        if (String(cause) === "unknown" && loopbackOrigin) {
          const gatewayCookie = (await session.defaultSession.cookies.get({ url: loopbackOrigin, name: "ticket" }))[0];
          if (gatewayCookie?.value === expected) {
            if (observedVersion !== directEventVersion || observedEpoch !== epoch || expected !== currentTicket()) return;
            const metadata = readSetting(metaKey(business.origin)) as Ticket | null;
            await put(session.defaultSession.cookies, business.origin, { ...(metadata ?? {}), value: expected!, httpOnly: true }, observedEpoch);
            return;
          }
        }
        if (observedVersion !== directEventVersion || observedEpoch !== epoch || expected !== currentTicket()) return;
        invalidateTicketSession([business.origin, ...(loopbackOrigin ? [loopbackOrigin] : [])]);
        if (loopbackOrigin) await session.defaultSession.cookies.remove(loopbackOrigin, "ticket");
        log.info("[TicketSession] direct cookie removal cleared mirror", { origin: business.origin });
      }).catch((error) => log.error("[TicketSession] cookie removal reconciliation failed", error));
      return;
    }
    // In gateway mode the business jar is written by this module itself; only
    // the trusted Set-Cookie callback may promote it to the settings mirror.
    if (loopbackOrigin) return;
    const observedEpoch = epoch;
    void (async () => {
      for (const delay of DIRECT_SYNC_RETRY_DELAYS_MS) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (observedVersion !== directEventVersion || observedEpoch !== epoch) return;
        if (await syncTicketFromJar(business.origin, observedEpoch, observedVersion)) return;
      }
      if (observedVersion === directEventVersion && observedEpoch === epoch)
        log.error("[TicketSession] direct sync exhausted retries", { origin: business.origin });
    })().catch((error) => log.error("[TicketSession] direct sync failed", error));
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
