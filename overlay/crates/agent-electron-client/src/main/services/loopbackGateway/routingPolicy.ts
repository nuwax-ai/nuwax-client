/** URL policy shared by Electron request interception and the HTTP/WS gateway. */
export const BACKEND_NAMESPACE = "/__backend";

export type BackendNamespaceRoute =
  | { kind: "none" }
  | { kind: "forbidden" }
  | { kind: "backend"; path: string };

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** Only the configured backend is a credential recipient; no alias host expansion. */
export function resolveBackendNamespace(
  requestPath: string,
  backendOrigin: string,
): BackendNamespaceRoute {
  const pathname = requestPath.split("?")[0];
  if (
    pathname !== BACKEND_NAMESPACE &&
    !pathname.startsWith(`${BACKEND_NAMESPACE}/`)
  )
    return { kind: "none" };
  const backend = httpUrl(backendOrigin);
  if (!backend || !requestPath.startsWith(`${BACKEND_NAMESPACE}/`))
    return { kind: "forbidden" };
  const rest = requestPath.slice(BACKEND_NAMESPACE.length + 1);
  const slash = rest.indexOf("/");
  // Compare the raw authority segment before decoding or constructing a URL.
  // This also rejects userinfo, escaped separators, different ports and aliases.
  if (slash < 0 || rest.slice(0, slash) !== backend.host)
    return { kind: "forbidden" };
  try {
    const upstream = new URL(`${backend.origin}${rest.slice(slash)}`);
    if (
      upstream.origin !== backend.origin ||
      upstream.username ||
      upstream.password
    )
      return { kind: "forbidden" };
    return { kind: "backend", path: upstream.pathname + upstream.search };
  } catch {
    return { kind: "forbidden" };
  }
}

export function backendNamespaceUrl(
  value: string,
  backendOrigin: string,
  gatewayOrigin: string,
): string | null {
  const source = httpUrl(value);
  const backend = httpUrl(backendOrigin);
  const gateway = httpUrl(gatewayOrigin);
  if (!source || !backend || !gateway || source.origin !== backend.origin)
    return null;
  const output = new URL(
    `${gateway.origin}${BACKEND_NAMESPACE}/${backend.host}${source.pathname}${source.search}${source.hash}`,
  );
  if (/^wss?:/i.test(value))
    output.protocol = gateway.protocol === "https:" ? "wss:" : "ws:";
  return output.href;
}

export function matchesBackendPrefix(
  pathname: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export interface GatewayRequestContext {
  url: string;
  resourceType: string;
  webContentsUrl: string;
  frameUrl?: string;
  parentFrameUrl?: string;
  referrer?: string;
}

export interface GatewayRoutingConfig {
  gatewayOrigin: string;
  backendOrigin: string;
  backendPrefixes: readonly string[];
}

/**
 * Documents keep their pathname so SPA routers retain their deployment base.
 * Only registered backend document roots own root-relative backend resources.
 * A backend CSS/module referrer can carry that ownership into nested resources.
 * The main SPA's local scripts/styles never acquire backend ownership by suffix.
 */
export function normalizeGatewayRequestUrl(
  request: GatewayRequestContext,
  config: GatewayRoutingConfig,
): string | null {
  // Electron/Chromium does not redirect WebSocket handshakes. Gateway WS URLs
  // already proxy every path; trusted direct backend WS uses ticket cookie injection.
  if (request.resourceType === "webSocket" || /^wss?:/i.test(request.url))
    return null;
  const url = httpUrl(request.url);
  const gateway = httpUrl(config.gatewayOrigin);
  const backend = httpUrl(config.backendOrigin);
  const page = httpUrl(request.webContentsUrl);
  if (!url || !gateway || !backend || !page || page.origin !== gateway.origin)
    return null;
  const document =
    request.resourceType === "mainFrame" || request.resourceType === "subFrame";
  let frame = request.frameUrl ? httpUrl(request.frameUrl) : null;
  // Electron reports an existing initial subframe as an empty URL. Only that
  // explicit empty value or about:blank/srcdoc may inherit a verified parent;
  // an absent/destroyed frame (undefined) never acquires the parent's authority.
  if (
    request.frameUrl === "" ||
    /^about:(blank|srcdoc)(?:[#?]|$)/.test(request.frameUrl ?? "")
  )
    frame = request.parentFrameUrl ? httpUrl(request.parentFrameUrl) : null;
  // A foreign/missing frame is untrusted even for document navigation. Otherwise
  // a foreign iframe could navigate to our backend and acquire gateway credentials.
  if (frame?.origin !== gateway.origin) return null;
  if (url.origin === backend.origin) {
    if (document)
      return `${gateway.origin}${url.pathname}${url.search}${url.hash}`;
    return backendNamespaceUrl(request.url, backend.origin, gateway.origin);
  }
  if (document || url.origin !== gateway.origin) return null;
  if (
    resolveBackendNamespace(url.pathname + url.search, backend.origin).kind !==
    "none"
  )
    return null;
  // Already-routed API/microapp resources retain their URLs and cookie path scope.
  if (matchesBackendPrefix(url.pathname, config.backendPrefixes)) return null;
  const referrer = request.referrer ? httpUrl(request.referrer) : null;
  const backendFrame =
    !!frame &&
    frame.origin === gateway.origin &&
    matchesBackendPrefix(frame.pathname, config.backendPrefixes);
  const backendReferrer =
    !!referrer &&
    referrer.origin === gateway.origin &&
    resolveBackendNamespace(referrer.pathname + referrer.search, backend.origin)
      .kind === "backend";
  if (!backendFrame && !backendReferrer) return null;
  const target = `${backend.origin}${url.pathname}${url.search}${url.hash}`;
  return backendNamespaceUrl(target, backend.origin, gateway.origin);
}

/** Keep same-backend redirects inside the namespace; external redirects stay external. */
export function namespaceRedirectLocation(
  location: string,
  upstreamPath: string,
  backendOrigin: string,
): string {
  const backend = httpUrl(backendOrigin);
  if (!backend) return location;
  try {
    const destination = new URL(location, `${backend.origin}${upstreamPath}`);
    if (
      destination.origin !== backend.origin ||
      destination.username ||
      destination.password
    )
      return location;
    return `${BACKEND_NAMESPACE}/${backend.host}${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return location;
  }
}
