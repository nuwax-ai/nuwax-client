import { app, session, webContents } from "electron";
import type { Session, WebContents, OnBeforeRequestListenerDetails } from "electron";
import {
  buildSpaDocumentUrl,
  parseBusinessDocumentUrl,
} from "@shared/utils/spaDocumentRoute";
import { normalizeGatewayRequestUrl, type GatewayRoutingConfig } from "./loopbackGateway/routingPolicy";

type NavigationDetails = { url?: string; isMainFrame?: boolean; isSameDocument?: boolean };
let gatewayConfig: GatewayRoutingConfig | null = null;
let directOrigin: () => string | null = () => null;
let mainHost: () => WebContents | null = () => null;
const installed = new WeakSet<Session>();
const observed = new WeakSet<WebContents>();
const navigationTargets = new WeakMap<WebContents, string>();

function observeNavigation(contents: WebContents): void {
  if (observed.has(contents)) return;
  observed.add(contents);
  const track = (details: NavigationDetails, url?: string, inPlace?: boolean, main?: boolean) => {
    if (!(details.isMainFrame ?? main) || (details.isSameDocument ?? inPlace)) return;
    const target = details.url ?? url;
    if (target) navigationTargets.set(contents, target);
  };
  contents.on("did-start-navigation", track);
  contents.on("will-redirect", track);
  const clear = () => navigationTargets.delete(contents);
  contents.on("did-navigate", clear);
  contents.on("did-fail-load", (_event, code, _description, url, main) => {
    const target = navigationTargets.get(contents);
    // 被新导航取消的旧请求不能清掉新目标（尤其是相同 pathname 的不同 hash）。
    if (main && code !== -3 && target && sameRequestUrl(target, url)) clear();
  });
  contents.on("render-process-gone", clear);
  contents.once("destroyed", clear);
}

function isMainHostWebview(contents: WebContents): boolean {
  const host = mainHost();
  return !contents.isDestroyed() && contents.getType() === "webview" &&
    !!host && !host.isDestroyed() && contents.hostWebContents === host;
}

function sameRequestUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a); const right = new URL(b);
    left.hash = ""; right.hash = "";
    return left.href === right.href;
  } catch { return false; }
}

/** 只绑定当前 WebContents 的当前请求；网络 URL 不含 hash 时从导航事件补全。 */
export function resolveDirectDocumentRequest(
  details: Pick<OnBeforeRequestListenerDetails, "url" | "method" | "resourceType">,
  origin: string | null,
  fullNavigationUrl?: string,
): string | null {
  if (!origin || details.method !== "GET" || details.resourceType !== "mainFrame") return null;
  const target = parseBusinessDocumentUrl(details.url, origin);
  if (!target) return null;
  if (fullNavigationUrl && sameRequestUrl(fullNavigationUrl, details.url)) {
    const full = parseBusinessDocumentUrl(fullNavigationUrl, origin);
    if (full) return buildSpaDocumentUrl(full);
  }
  return buildSpaDocumentUrl(target);
}

function installRequestListener(ses: Session): void {
  if (installed.has(ses)) return;
  ses.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      let redirectURL: string | null = null;
      try {
        const contents = details.webContents ?? (details.webContentsId ? webContents.fromId(details.webContentsId) : null);
        if (gatewayConfig) {
          redirectURL = normalizeGatewayRequestUrl({
            url: details.url, resourceType: details.resourceType,
            webContentsUrl: contents?.getURL() ?? "",
            frameUrl: details.frame?.url, parentFrameUrl: details.frame?.parent?.url,
            referrer: details.referrer,
          }, gatewayConfig);
        } else if (contents && isMainHostWebview(contents)) {
          observeNavigation(contents);
          const recorded = navigationTargets.get(contents);
          const full = recorded && sameRequestUrl(recorded, details.url) ? recorded : contents.getURL();
          redirectURL = resolveDirectDocumentRequest(details, directOrigin(), full);
        }
      } catch { /* 已销毁 frame/窗口不获取额外请求能力。 */ }
      callback(redirectURL ? { redirectURL } : {});
    },
  );
  installed.add(ses);
}

/** 在首个商业窗口创建前安装；配置变化不重新注册 Session 监听器。 */
export function initBusinessRequestRouting(
  getDirectOrigin: () => string | null,
  getMainHost: () => WebContents | null,
): void {
  directOrigin = getDirectOrigin;
  mainHost = getMainHost;
  installRequestListener(session.defaultSession);
  app.on("web-contents-created", (_event, contents) => {
    if (contents.session === session.defaultSession) observeNavigation(contents);
  });
}

/** loopback 生命周期只改变策略，不覆盖或注销 direct 共用监听器。 */
export function setGatewayRequestRouting(config: GatewayRoutingConfig | null): void {
  gatewayConfig = config;
  if (config) installRequestListener(session.defaultSession);
}
