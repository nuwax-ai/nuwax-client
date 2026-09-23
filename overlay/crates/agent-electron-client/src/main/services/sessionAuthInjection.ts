import { session, webContents } from "electron";
import type { OnBeforeSendHeadersListenerDetails, WebContents } from "electron";
import log from "electron-log";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import {
  hasOrigin,
  isPublicAuthPath,
  matchesBusinessOrigin,
  stripTicketCookie,
} from "./auth/requestPolicy";
import { GATEWAY_REQUEST_HEADER } from "./loopbackGateway/requestContext";

export interface SessionAuthContext {
  businessOrigin: string;
  trustedOrigins: string[];
  gateway?: { origin: string; requestSecret: string } | null;
}

// Only a main-process-created business window may authenticate its initial document
// before Electron has a committed frame URL. Never infer trust from the destination.
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
  const contents = details.webContents;
  if (!contents || contents.isDestroyed()) return false;
  const topUrl = contents.getURL();
  if (hasOrigin(topUrl, context.trustedOrigins)) {
    // Checking only webContents would also trust an external iframe in our window.
    if (!details.frame) return false;
    if (hasOrigin(details.frame.url, context.trustedOrigins)) return true;
    return (
      details.resourceType === "subFrame" &&
      (!details.frame.url || details.frame.url === "about:blank") &&
      !!details.frame.parent &&
      hasOrigin(details.frame.parent.url, context.trustedOrigins)
    );
  }
  return (
    details.resourceType === "mainFrame" &&
    (!topUrl || topUrl === "about:blank") &&
    initialNavigations.get(contents) === details.url &&
    matchesBusinessOrigin(details.url, context.businessOrigin)
  );
}

export function applySessionAuthHeaders(
  details: OnBeforeSendHeadersListenerDetails,
  context: SessionAuthContext
): Record<string, string> {
  const headers = { ...details.requestHeaders };
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
  // Cookies are host scoped, not port scoped. A ticket for our gateway would
  // otherwise be sent to every unrelated service listening on 127.0.0.1.
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname);
  const trustedGateway = !!context.gateway &&
    matchesBusinessOrigin(details.url, context.gateway.origin) &&
    !!headers[GATEWAY_REQUEST_HEADER];
  if (isLocal && !trustedGateway) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== "cookie") continue;
      const value = stripTicketCookie(headers[key]);
      if (value) headers[key] = value;
      else delete headers[key];
    }
  }
  // Preserve main.ts's product header, while correctly recognizing bracketed IPv6.
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname)) {
    for (const key of Object.keys(headers))
      if (key.toLowerCase() === "x-client-type") delete headers[key];
    headers["x-client-type"] = APP_NAME_IDENTIFIER;
  }
  if (!matchesBusinessOrigin(details.url, context.businessOrigin)) return headers;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") delete headers[key];
    if (key.toLowerCase() !== "cookie" ||
        (!isPublicAuthPath(target.pathname) && trustedRequest(details, context))) continue;
    const cookie = stripTicketCookie(headers[key]);
    if (cookie) headers[key] = cookie;
    else delete headers[key];
  }
  return headers;
}

/** Called after main.ts installs x-client-type and before any application window. */
export function initSessionAuthInjection(
  getContext: () => SessionAuthContext
): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      const contents =
        details.webContents ??
        (details.webContentsId
          ? webContents.fromId(details.webContentsId)
          : undefined);
      callback({
        requestHeaders: applySessionAuthHeaders(
          { ...details, webContents: contents ?? undefined },
          getContext()
        ),
      });
    }
  );
  log.info(
    "[SessionAuth] onBeforeSendHeaders ownership installed (product + business auth)"
  );
}
