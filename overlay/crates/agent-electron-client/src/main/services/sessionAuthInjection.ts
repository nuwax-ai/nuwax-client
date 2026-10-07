import { session, webContents } from "electron";
import type { Cookie, OnBeforeSendHeadersListenerDetails, WebContents } from "electron";
import log from "electron-log";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import {
  isPublicAuthPath,
  matchesBusinessOrigin,
  stripTicketCookie,
} from "./auth/requestPolicy";
import { currentTicket } from "./commercialTicketSession";
import { GATEWAY_REQUEST_HEADER } from "./loopbackGateway/requestContext";
import { consumeNativeTicketCapability } from "./nativeTicketCapability";

export interface SessionAuthContext {
  businessOrigin: string;
  trustedOrigins: string[];
  gateway?: { origin: string; requestSecret: string } | null;
}

function ticketValues(cookie: string): string[] {
  return cookie.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === "ticket"
      ? [part.slice(separator + 1).trim()] : [];
  });
}

/** Cookie provenance lasts for one installed browser-session policy. */
export class SessionTicketProvenance {
  private readonly values = new Set<string>();
  private readonly businessOrigins = new Set<string>();
  private readonly gatewayHosts = new Set<string>();

  rememberContext(context: SessionAuthContext): void {
    this.businessOrigins.add(context.businessOrigin);
    if (context.gateway) this.gatewayHosts.add(new URL(context.gateway.origin).hostname);
    const ticket = currentTicket();
    if (ticket) this.values.add(ticket);
  }

  rememberValues(cookie: string): void {
    for (const value of ticketValues(cookie)) this.values.add(value);
  }

  rememberCookie(cookie: Cookie): void {
    if (cookie.name !== "ticket" || !cookie.value || !cookie.domain) return;
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    const matches = [...this.businessOrigins].some((origin) => {
      const hostname = new URL(origin).hostname.toLowerCase();
      return hostname === domain ||
        (!cookie.hostOnly && hostname.endsWith(`.${domain}`));
    });
    // Cookie metadata has no port. A third-party loopback cookie must not be
    // promoted into a business value just because its host matches the gateway.
    if (matches) this.values.add(cookie.value);
  }

  strip(cookie: string, target: URL, lookupFailed: boolean): string | undefined {
    // Gateway-host cookies are shared across every port. Unknown values there
    // cannot safely be distinguished from a restored business ticket. A failed
    // provenance read also cannot establish third-party ownership, so fail closed.
    if (lookupFailed || this.gatewayHosts.has(target.hostname)) return stripTicketCookie(cookie);
    return cookie.split(";").filter((part) => {
      const separator = part.indexOf("=");
      return separator < 0 || part.slice(0, separator).trim() !== "ticket" ||
        !this.values.has(part.slice(separator + 1).trim());
    }).map((part) => part.trim()).filter(Boolean).join("; ") || undefined;
  }
}

// API/download documents need explicit source admission before a committed frame.
// Ordinary GET pages follow normal browser navigation separately below.
const initialNavigations = new WeakMap<WebContents, string>();
export function trustInitialBusinessNavigation(
  contents: WebContents,
  url: string
): void {
  initialNavigations.set(contents, url);
  contents.once("did-navigate", () => initialNavigations.delete(contents));
}

function trustedRequest(
  details: OnBeforeSendHeadersListenerDetails,
  context: SessionAuthContext
): boolean {
  try {
    const contents = details.webContents;
    if (!contents || contents.isDestroyed()) return false;
    const topUrl = contents.getURL();
    const trustedOrigin = (url: string) => context.trustedOrigins.some((origin) =>
      matchesBusinessOrigin(url, origin));
    const target = new URL(details.url);
    const ordinaryDocument = (details.method ?? "GET").toUpperCase() === "GET" &&
      /^https?:$/.test(target.protocol) && !target.username && !target.password &&
      trustedOrigin(details.url) &&
      target.pathname !== "/api" && !target.pathname.startsWith("/api/");
    // Top-level GET links and cross-origin returns are browser navigations, even
    // when the previous page was third-party or the new popup has no frame yet.
    if (ordinaryDocument && details.resourceType === "mainFrame") return true;
    if (details.frame?.detached) return false;
    if (trustedOrigin(topUrl)) {
      if (ordinaryDocument && details.resourceType === "subFrame") return true;
      // Checking only webContents would also trust an external iframe in our window.
      if (!details.frame) return false;
      if (trustedOrigin(details.frame.url)) return true;
      return (
        details.resourceType === "subFrame" &&
        (!details.frame.url || details.frame.url === "about:blank") &&
        !!details.frame.parent &&
        trustedOrigin(details.frame.parent.url)
      );
    }
    return (
      details.resourceType === "mainFrame" &&
      (!topUrl || topUrl === "about:blank") &&
      initialNavigations.get(contents) === details.url &&
      (matchesBusinessOrigin(details.url, context.businessOrigin) ||
        (!!context.gateway && matchesBusinessOrigin(details.url, context.gateway.origin)))
    );
  } catch {
    // Detached/destroyed Electron frames can throw when reading their URL.
    return false;
  }
}

export function applySessionAuthHeaders(
  details: OnBeforeSendHeadersListenerDetails,
  context: SessionAuthContext,
  provenance = new SessionTicketProvenance(),
  cookieLookupFailed = false,
): Record<string, string> {
  const headers = { ...details.requestHeaders };
  const nativeTicketRequest = consumeNativeTicketCapability(headers);
  provenance.rememberContext(context);
  // The gateway capability is main-process-only. Renderer-provided copies must
  // never survive, including redirects to an unrelated destination.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === GATEWAY_REQUEST_HEADER) delete headers[key];
  }
  let target: URL;
  try {
    target = new URL(details.url);
  } catch {
    return headers;
  }
  if (
    context.gateway?.requestSecret &&
    matchesBusinessOrigin(details.url, context.gateway.origin) &&
    !target.username &&
    !target.password &&
    details.webContentsId &&
    details.webContentsId > 0 &&
    trustedRequest(details, context)
  ) {
    // The gateway only lends the stored ticket to requests from a trusted
    // Electron frame. The capability also identifies opaque redirects for CORS.
    headers[GATEWAY_REQUEST_HEADER] = context.gateway.requestSecret;
  }
  // Chromium cookies can be scoped to a parent domain as well as a host. A
  // redirect to another subdomain (or loopback port) must not carry our ticket.
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname);
  const trustedGateway = !!context.gateway &&
    matchesBusinessOrigin(details.url, context.gateway.origin) &&
    !!headers[GATEWAY_REQUEST_HEADER];
  const businessTarget = matchesBusinessOrigin(details.url, context.businessOrigin);
  const gatewayTarget = !!context.gateway && matchesBusinessOrigin(details.url, context.gateway.origin);
  if (businessTarget || gatewayTarget || nativeTicketRequest) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "cookie")
        provenance.rememberValues(headers[key]);
    }
  }
  const ticketAllowed = trustedGateway ||
    (businessTarget && !isPublicAuthPath(target.pathname) &&
      (nativeTicketRequest || trustedRequest(details, context)));
  if (!ticketAllowed) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== "cookie") continue;
      const value = businessTarget || gatewayTarget
        ? stripTicketCookie(headers[key]) : provenance.strip(headers[key], target, cookieLookupFailed);
      if (value) headers[key] = value;
      else delete headers[key];
    }
  }
  // Preserve main.ts's product header, while correctly recognizing bracketed IPv6.
  if (!isLocal) {
    for (const key of Object.keys(headers))
      if (key.toLowerCase() === "x-client-type") delete headers[key];
    headers["x-client-type"] = APP_NAME_IDENTIFIER;
  }
  if (!businessTarget) return headers;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") delete headers[key];
  }
  // Loopback documents are cross-site to an absolute business WebSocket, so
  // Chromium omits the SameSite=Lax ticket on the handshake. Only a trusted
  // frame may borrow the current ticket for this exact business origin.
  if (details.resourceType === "webSocket" &&
      (target.protocol === "ws:" || target.protocol === "wss:") &&
      !isPublicAuthPath(target.pathname) && trustedRequest(details, context)) {
    const ticket = currentTicket();
    if (ticket) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== "cookie") continue;
        const cookie = stripTicketCookie(headers[key]);
        if (cookie) headers[key] = cookie;
        else delete headers[key];
      }
      const cookieKey = Object.keys(headers).find((key) => key.toLowerCase() === "cookie") ?? "Cookie";
      headers[cookieKey] = [headers[cookieKey], `ticket=${ticket}`].filter(Boolean).join("; ");
    }
  }
  return headers;
}

/** Called after main.ts installs x-client-type and before any application window. */
export function initSessionAuthInjection(
  getContext: () => SessionAuthContext
): void {
  const provenance = new SessionTicketProvenance();
  provenance.rememberContext(getContext());
  const cookies = session.defaultSession.cookies;
  cookies?.on("changed", (_event, cookie) => {
    provenance.rememberContext(getContext());
    provenance.rememberCookie(cookie);
  });
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      provenance.rememberContext(getContext());
      const contents =
        details.webContents ??
        (details.webContentsId
          ? webContents.fromId(details.webContentsId)
          : undefined);
      const finish = (lookupFailed = false) => callback({ requestHeaders: applySessionAuthHeaders(
        { ...details, webContents: contents ?? undefined }, getContext(), provenance, lookupFailed),
      });
      // Read provenance for cookies Chromium actually selected. This also covers
      // old parent-domain tickets loaded from disk before the listener existed.
      const hasTicket = Object.entries(details.requestHeaders).some(([key, value]) =>
        key.toLowerCase() === "cookie" && ticketValues(value).length > 0);
      if (!hasTicket) return finish();
      if (!cookies) return finish(true);
      try {
        void cookies.get({ url: details.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:"), name: "ticket" })
          .then((selected) => {
            // Domain changes can happen while the asynchronous jar read is in flight.
            provenance.rememberContext(getContext());
            selected.forEach((cookie) => provenance.rememberCookie(cookie));
            finish();
          }, () => finish(true));
      } catch {
        // Electron can also reject a malformed filter synchronously.
        finish(true);
      }
    }
  );
  log.info(
    "[SessionAuth] onBeforeSendHeaders ownership installed (product + business auth)"
  );
}
