import { app, webContents } from "electron";
import type { BrowserWindow, WebContents } from "electron";

/** Only explicit conversation routes count. Project/app IDs are not conversation IDs. */
export function conversationIdFromUrl(value: string): string | null {
  try {
    const page = new URL(value);
    const route = page.hash.startsWith("#/") ? new URL(page.hash.slice(1), page.origin) : page;
    const path = route.pathname.replace(/\/$/, "");
    const match = /^\/home\/chat\/([^/]+)\/[^/]+$/.exec(path)
      ?? /^\/app\/chat\/[^/]+\/([^/]+)$/.exec(path)
      ?? /^\/space\/[^/]+\/app-pro\/[^/]+\/([^/]+)$/.exec(path);
    const id = match ? decodeURIComponent(match[1])
      : /^\/space\/[^/]+\/agent-dev$/.test(path) ? route.searchParams.get("conversationId") : null;
    return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !["0", "-1", "undefined", "null"].includes(id) ? id : null;
  } catch { return null; }
}

/** Native navigation is the source of truth, so cached/hidden chats cannot claim the preview. */
export function observeCuaConversation(options: {
  getMainWindow(): BrowserWindow | null;
  isCurrentDocument(contents: WebContents): boolean;
  changed(): void;
}) {
  let main: BrowserWindow | null = null, guest: WebContents | null = null;
  let navigating = false, current: string | null = null, disposed = false;
  const cleanups = new Map<WebContents, () => void>();
  const belongs = (contents: WebContents) => !!main && !main.isDestroyed() && !contents.isDestroyed()
    && contents.getType() === "webview" && contents.hostWebContents === main.webContents;
  const get = (): string | null => {
    if (disposed || navigating || !guest || !belongs(guest) || !options.isCurrentDocument(guest)) return null;
    return conversationIdFromUrl(guest.getURL());
  };
  const publish = () => {
    const next = get();
    if (next !== current) { current = next; options.changed(); }
  };
  const trackGuest = (contents: WebContents) => {
    if (!belongs(contents)) return;
    guest = contents; navigating = false;
    if (!cleanups.has(contents)) {
      const navigation = () => { if (guest === contents) { navigating = false; publish(); } };
      const inPage = (_event: unknown, _url: string, isMainFrame: boolean) => { if (isMainFrame !== false) navigation(); };
      const start = (event: { isMainFrame?: boolean; isSameDocument?: boolean }, _url: string, inPlace: boolean, isMainFrame: boolean) => {
        if (guest === contents && (event.isMainFrame ?? isMainFrame) && !(event.isSameDocument ?? inPlace)) {
          navigating = true; publish();
        }
      };
      const destroyed = () => { if (guest === contents) { guest = null; publish(); } cleanups.get(contents)?.(); cleanups.delete(contents); };
      contents.on("did-start-navigation", start); contents.on("did-navigate", navigation);
      contents.on("did-navigate-in-page", inPage); contents.on("dom-ready", navigation); contents.on("destroyed", destroyed);
      cleanups.set(contents, () => {
        contents.removeListener("did-start-navigation", start); contents.removeListener("did-navigate", navigation);
        contents.removeListener("did-navigate-in-page", inPage); contents.removeListener("dom-ready", navigation); contents.removeListener("destroyed", destroyed);
      });
    }
    publish();
  };
  const attached = (_event: unknown, contents: WebContents) => trackGuest(contents);
  const closed = () => {
    detachMain(); guest = null; main = null; navigating = false; publish();
    for (const cleanup of cleanups.values()) cleanup(); cleanups.clear();
  };
  const detachMain = () => {
    if (main) { main.webContents.removeListener("did-attach-webview", attached); main.removeListener("closed", closed); }
  };
  const refreshMain = () => {
    if (disposed) return;
    const next = options.getMainWindow();
    if (next === main) return;
    detachMain(); main = next; guest = null; navigating = false;
    if (main && !main.isDestroyed()) {
      main.webContents.on("did-attach-webview", attached); main.on("closed", closed);
      // Feature registration can follow the initial guest attachment.
      const existing = webContents.getAllWebContents().filter(belongs);
      if (existing.length === 1) trackGuest(existing[0]);
    }
    publish();
  };
  const created = () => { setImmediate(refreshMain); };
  app.on("browser-window-created", created);
  refreshMain();
  return { get, dispose() {
    disposed = true; detachMain();
    for (const cleanup of cleanups.values()) cleanup(); cleanups.clear();
    app.removeListener("browser-window-created", created);
  } };
}
