import { BrowserWindow, WebContentsView, webContents } from "electron";
import type { FoundInPageResult, IpcMainEvent, WebContents } from "electron";
import path from "node:path";
import log from "electron-log";
import { t } from "../i18n";

const surfaces = new WeakMap<WebContents, { guest: WebContents; focus: () => void; close: () => void }>();

function findHtml(): string {
  const label = (key: string) => t(`Claw.Browser.${key}`).replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{color-scheme:light dark;font:13px system-ui}*{box-sizing:border-box}
body{margin:0;padding:6px;display:flex;align-items:center;gap:4px;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:7px}
input{min-width:0;flex:1;height:30px;border:1px solid GrayText;border-radius:4px;padding:4px 7px;background:Canvas;color:CanvasText}
output{min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
button{height:30px;min-width:28px;border:0;border-radius:4px;background:ButtonFace;color:ButtonText;cursor:pointer}
button:hover{background:Highlight;color:HighlightText}input:focus-visible,button:focus-visible{outline:2px solid Highlight;outline-offset:-2px}
</style></head><body>
<input id="query" type="text" maxlength="4096" placeholder="${label("find")}" aria-label="${label("find")}">
<output id="count" aria-live="polite">0/0</output>
<button id="previous" title="${label("findPrevious")}" aria-label="${label("findPrevious")}">↑</button>
<button id="next" title="${label("findNext")}" aria-label="${label("findNext")}">↓</button>
<button id="close" title="${label("close")}" aria-label="${label("close")}">×</button>
</body></html>`;
}

/** One contained find bar per host, always bound to the shortcut's guest. */
export function openWebviewFind(host: WebContents, guest: WebContents): void {
  if (host.isDestroyed() || guest.isDestroyed()) return;
  const previous = surfaces.get(host);
  if (previous?.guest === guest) { previous.focus(); return; }
  previous?.close();
  const owner = BrowserWindow.fromWebContents(host);
  if (!owner || owner.isDestroyed()) return;

  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, "..", "preload", "webviewFind.js"),
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    devTools: false, spellcheck: false,
  } });
  const bar = view.webContents;
  const url = "data:text/html;charset=utf-8," + encodeURIComponent(findHtml());
  let closed = false, ready = false, query = "", requestId = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let focusCheck: ReturnType<typeof setImmediate> | undefined;
  const alive = () => !closed && !guest.isDestroyed() && !bar.isDestroyed() && !owner.isDestroyed();
  const cancelInput = () => { clearTimeout(timer); timer = undefined; };
  const counts = (activeMatchOrdinal = 0, matches = 0) => {
    if (alive() && ready) bar.send("webview-find:count", { activeMatchOrdinal, matches });
  };
  const close = (restoreFocus = false) => {
    if (closed) return;
    closed = true;
    cancelInput();
    clearImmediate(focusCheck);
    surfaces.delete(host);
    guest.removeListener("found-in-page", found);
    guest.removeListener("blur", checkFocus);
    guest.removeListener("destroyed", dismiss);
    guest.removeListener("render-process-gone", dismiss);
    guest.removeListener("did-start-navigation", navigating);
    guest.removeListener("before-input-event", guestInput);
    host.removeListener("focus", checkFocus);
    host.removeListener("destroyed", dismiss);
    owner.removeListener("resize", layout);
    owner.removeListener("blur", dismiss);
    owner.removeListener("hide", dismiss);
    owner.removeListener("closed", dismiss);
    if (!guest.isDestroyed()) guest.stopFindInPage("clearSelection");
    if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
    if (!bar.isDestroyed()) bar.close({ waitForBeforeUnload: false });
    if (restoreFocus && !guest.isDestroyed() && !owner.isDestroyed() && owner.isFocused()) guest.focus();
  };
  const dismiss = () => close();
  const guestInput = (event: Electron.Event, input: Electron.Input) => {
    if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); close(true); }
  };
  // Moving focus into our bar is expected; leaving both surfaces ends this session.
  const checkFocus = () => {
    clearImmediate(focusCheck);
    focusCheck = setImmediate(() => {
      focusCheck = undefined;
      const focused = webContents.getFocusedWebContents();
      if (!alive() || (focused !== guest && focused !== bar)) close();
    });
  };
  const navigating = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) close();
  };
  const layout = () => {
    if (!alive()) return;
    const [width, height] = owner.getContentSize();
    const extent = Math.min(400, width);
    view.setBounds({ x: Math.max(0, width - extent - 12), y: Math.min(48, Math.max(0, height - 44)), width: extent, height: 44 });
  };
  const focus = () => {
    if (!alive() || !ready || !owner.isFocused()) return;
    bar.focus();
    bar.send("webview-find:focus");
  };
  const find = (text: string, next: boolean, forward: boolean) => {
    if (!alive()) { close(); return; }
    cancelInput();
    if (!text) {
      query = ""; requestId = -1;
      guest.stopFindInPage("clearSelection");
      counts();
      return;
    }
    // Electron's findNext means *start a new session*, false continues it.
    const newSession = !next || text !== query;
    if (newSession) counts();
    requestId = guest.findInPage(text, { findNext: newSession, forward });
    query = text;
  };
  const found = (_event: unknown, result: FoundInPageResult) => {
    if (result.requestId === requestId) counts(result.activeMatchOrdinal, result.matches);
  };
  const command = (event: IpcMainEvent, channel: string, value: unknown) => {
    if (!alive() || !ready || channel !== "webview-find:command" || event.sender !== bar ||
        event.senderFrame !== bar.mainFrame || event.senderFrame.url !== url || bar.getURL() !== url) return;
    if (!value || typeof value !== "object") return;
    const { type, text } = value as { type?: unknown; text?: unknown };
    if (type === "close") { close(true); return; }
    if (typeof text !== "string" || text.length > 4096) return;
    if (type === "input") {
      cancelInput();
      // Retire the previous request immediately, before the debounce elapses.
      requestId = -1;
      counts();
      timer = setTimeout(() => find(text, false, true), 100);
    } else if (type === "next" || type === "previous") find(text, true, type === "next");
  };

  surfaces.set(host, { guest, focus, close: dismiss });
  view.setVisible(false);
  owner.contentView.addChildView(view);
  layout();
  owner.on("resize", layout);
  owner.on("blur", dismiss);
  owner.on("hide", dismiss);
  owner.on("closed", dismiss);
  host.on("focus", checkFocus);
  host.on("destroyed", dismiss);
  guest.on("found-in-page", found);
  guest.on("blur", checkFocus);
  guest.on("destroyed", dismiss);
  guest.on("render-process-gone", dismiss);
  guest.on("did-start-navigation", navigating);
  guest.on("before-input-event", guestInput);
  bar.on("blur", checkFocus);
  bar.on("destroyed", dismiss);
  bar.on("render-process-gone", dismiss);
  bar.on("ipc-message", command);
  bar.setWindowOpenHandler(() => ({ action: "deny" }));
  bar.on("will-navigate", event => event.preventDefault());
  bar.on("will-attach-webview", event => event.preventDefault());
  bar.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "Escape") { event.preventDefault(); close(true); }
    else if (!input.shift && !input.alt && (input.control || input.meta) && input.key.toLowerCase() === "f") {
      event.preventDefault(); focus();
    }
  });
  void bar.loadURL(url).then(() => {
    if (!alive()) return;
    const focused = webContents.getFocusedWebContents();
    if (!owner.isFocused() || (focused !== guest && focused !== bar)) { close(); return; }
    ready = true;
    view.setVisible(true);
    focus();
  }).catch(() => {
    log.warn("[WebviewPolicy] Failed to load webview find bar");
    close();
  });
}
