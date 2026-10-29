import {
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import path from "node:path";
import {
  BROWSER_IPC,
  type BrowserCommand,
  type BrowserState,
} from "@shared/features/browser/contract";
import type { FeatureContext } from "../_kit/types";
import { PageView } from "./vendor/pageView";

export interface BrowserPageOptions {
  windowOptions: BrowserWindowConstructorOptions;
  initialUrl?: string;
  /** Host supplies the existing Chromium popup guest, including its opener/POST navigation. */
  guest?: WebContents;
  toolbarUrl?: string;
  preloadPath?: string;
}
export interface BrowserPage {
  window: BrowserWindow;
  contents: WebContents;
}
type Entry = BrowserPage & {
  page: PageView;
  toolbarUrl: string;
  state: BrowserState;
  showing: boolean;
  toolbarReady: boolean;
  hasDocument: boolean;
  findRequest: number;
  query: string;
};
const LABELS = [
  "back",
  "forward",
  "reload",
  "stop",
  "copy",
  "external",
  "more",
  "pin",
  "unpin",
  "print",
  "zoom",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "find",
  "findPrevious",
  "findNext",
  "close",
  "failed",
  "retry",
  "externalFailed",
  "copyDone",
  "printFailed",
  "url",
] as const;

function webUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Only the locally owned toolbar main frame can control its associated page. */
export function isBrowserToolbar(
  event: IpcMainInvokeEvent,
  entry: BrowserPage & { toolbarUrl: string }
): boolean {
  try {
    const toolbar = entry.window.webContents;
    return (
      !entry.window.isDestroyed() &&
      !toolbar.isDestroyed() &&
      event.sender === toolbar &&
      event.senderFrame === toolbar.mainFrame &&
      toolbar.getURL() === entry.toolbarUrl &&
      event.senderFrame?.url === entry.toolbarUrl
    );
  } catch {
    return false;
  }
}

export function createBrowserWindows(ctx: FeatureContext) {
  const entries = new Map<number, Entry>();
  let disposed = false;
  const labels = () =>
    Object.fromEntries(
      LABELS.map((key) => [key, ctx.translate?.(`Claw.Browser.${key}`) ?? key])
    );
  const push = (entry: Entry) => {
    if (entry.window.isDestroyed() || entry.contents.isDestroyed()) return;
    const wc = entry.contents;
    const url = wc.getURL();
    if (!entry.state.error && webUrl(url)) entry.state.url = url;
    entry.state.domain = (() => {
      try {
        return new URL(entry.state.url).host;
      } catch {
        return "";
      }
    })();
    entry.state.title = wc.getTitle() || entry.state.domain;
    entry.state.canGoBack = wc.navigationHistory.canGoBack();
    entry.state.canGoForward = wc.navigationHistory.canGoForward();
    entry.state.loading = wc.isLoading();
    entry.state.zoom = Math.round(wc.getZoomFactor() * 100);
    entry.state.pinned = entry.window.isAlwaysOnTop();
    entry.state.labels = labels();
    const theme = ctx.settings.read("theme_mode") ?? "system";
    entry.state.dark =
      theme === "dark" ||
      (theme === "system" && nativeTheme.shouldUseDarkColors);
    if (entry.toolbarReady)
      entry.window.webContents.send(BROWSER_IPC.changed, entry.state);
  };
  const show = (entry: Entry) => {
    if (
      !entry.showing &&
      entry.toolbarReady &&
      (entry.hasDocument || entry.state.error) &&
      !entry.window.isDestroyed()
    ) {
      entry.showing = true;
      entry.window.show();
      entry.window.focus();
    }
  };
  const findOpen = (entry: Entry, enabled: boolean) => {
    entry.state.finding = enabled;
    entry.page.toolbarHeight = enabled ? 94 : 52;
    entry.page.invalidateLayout();
    if (!enabled) {
      entry.query = "";
      entry.findRequest = -1;
      entry.contents.stopFindInPage("clearSelection");
      entry.state.matches = entry.state.activeMatch = 0;
      entry.contents.focus();
    }
    push(entry);
  };
  const external = async (entry: Entry) => {
    const target = webUrl(entry.state.url);
    if (!target) return false;
    try {
      await shell.openExternal(target);
      return true;
    } catch {
      if (!entry.window.isDestroyed())
        await dialog.showMessageBox(entry.window, {
          type: "error",
          message: entry.state.labels.externalFailed,
          buttons: [entry.state.labels.close],
        });
      return false;
    }
  };
  const execute = async (
    entry: Entry,
    command: BrowserCommand
  ): Promise<boolean> => {
    if (
      disposed ||
      entry.window.isDestroyed() ||
      entry.contents.isDestroyed() ||
      !command ||
      typeof command !== "object"
    )
      return false;
    const wc = entry.contents;
    switch (command.type) {
      case "back":
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case "forward":
        if (wc.navigationHistory.canGoForward())
          wc.navigationHistory.goForward();
        break;
      case "reload": {
        const failedUrl = entry.state.error && webUrl(entry.state.url);
        entry.state.error = null;
        entry.page.view.setVisible(true);
        if (failedUrl) void wc.loadURL(failedUrl).catch(() => {});
        else wc.reload();
        break;
      }
      case "stop":
        wc.stop();
        break;
      case "copy": {
        const url = webUrl(entry.state.url);
        if (!url) return false;
        clipboard.writeText(url);
        break;
      }
      case "external":
        return external(entry);
      case "pin":
        entry.window.setAlwaysOnTop(!entry.window.isAlwaysOnTop());
        break;
      case "zoom-in":
        wc.setZoomFactor(Math.min(3, wc.getZoomFactor() + 0.1));
        break;
      case "zoom-out":
        wc.setZoomFactor(Math.max(0.5, wc.getZoomFactor() - 0.1));
        break;
      case "zoom-reset":
        wc.setZoomFactor(1);
        break;
      case "print":
        wc.print({ silent: false }, (success, reason) => {
          if (!success && reason !== "cancelled" && !entry.window.isDestroyed())
            void dialog
              .showMessageBox(entry.window, {
                type: "error",
                message: entry.state.labels.printFailed,
                buttons: [entry.state.labels.close],
              })
              .catch(() => {});
        });
        break;
      case "find-open":
        findOpen(entry, true);
        entry.window.webContents.focus();
        break;
      case "find-close":
        findOpen(entry, false);
        break;
      case "find": {
        if (typeof command.text !== "string" || command.text.length > 4096)
          return false;
        if (!command.text) {
          wc.stopFindInPage("clearSelection");
          entry.query = "";
          entry.findRequest = -1;
          entry.state.matches = entry.state.activeMatch = 0;
        } else {
          entry.findRequest = wc.findInPage(command.text, {
            forward: command.forward !== false,
            findNext: entry.query !== command.text || !command.next,
          });
          entry.query = command.text;
        }
        break;
      }
      case "menu": {
        const action = (type: BrowserCommand["type"]) => () => {
          void execute(entry, { type } as BrowserCommand).catch(() =>
            ctx.log.warn("[Browser] Menu action failed")
          );
        };
        const l = entry.state.labels;
        Menu.buildFromTemplate([
          {
            label: l.reload,
            accelerator: "CmdOrCtrl+R",
            click: action("reload"),
          },
          { label: l.copy, click: action("copy") },
          { label: l.external, click: action("external") },
          { type: "separator" },
          {
            label: l.find,
            accelerator: "CmdOrCtrl+F",
            click: action("find-open"),
          },
          {
            label: `${l.zoom} (${entry.state.zoom}%)`,
            submenu: [
              {
                label: l.zoomIn,
                accelerator: "CmdOrCtrl+Plus",
                click: action("zoom-in"),
              },
              {
                label: l.zoomOut,
                accelerator: "CmdOrCtrl+-",
                click: action("zoom-out"),
              },
              {
                label: l.zoomReset,
                accelerator: "CmdOrCtrl+0",
                click: action("zoom-reset"),
              },
            ],
          },
          {
            label: l.print,
            accelerator: "CmdOrCtrl+P",
            click: action("print"),
          },
          { type: "separator" },
          {
            label: l.pin,
            type: "checkbox",
            checked: entry.window.isAlwaysOnTop(),
            click: action("pin"),
          },
        ]).popup({
          window: entry.window,
          x: Math.max(0, entry.window.getContentSize()[0] - 240),
          y: 52,
        });
        break;
      }
      default:
        return false;
    }
    push(entry);
    return true;
  };
  const owned = (event: IpcMainInvokeEvent) => {
    const entry = entries.get(event.sender.id);
    return entry && isBrowserToolbar(event, entry) ? entry : null;
  };
  const refresh = () => { for (const entry of entries.values()) push(entry); };
  try {
    ipcMain.handle(BROWSER_IPC.state, (event) => {
      const entry = owned(event);
      if (!entry) return null;
      push(entry);
      return entry.state;
    });
    ipcMain.handle(
      BROWSER_IPC.command,
      async (event, command: BrowserCommand) => {
        const entry = owned(event);
        if (!entry) return false;
        try {
          return await execute(entry, command);
        } catch {
          ctx.log.warn("[Browser] Window action failed");
          return false;
        }
      }
    );
    nativeTheme.on('updated', refresh);
  } catch (error) {
    ipcMain.removeHandler(BROWSER_IPC.state);
    ipcMain.removeHandler(BROWSER_IPC.command);
    throw error;
  }

  const open = (options: BrowserPageOptions): BrowserPage => {
    if (disposed) throw new Error("Browser feature is disposed");
    const parentEntry = ctx.windows.getMain()?.webContents.getURL();
    const toolbarUrl =
      options.toolbarUrl ??
      (parentEntry ? new URL("./browser.html", parentEntry).href : "");
    if (!toolbarUrl) throw new Error("Browser toolbar entry unavailable");
    const {
      webPreferences,
      webContents: _guest,
      ...windowOptions
    } = options.windowOptions as BrowserWindowConstructorOptions & {
      webContents?: WebContents;
    };
    const win = new BrowserWindow({
      ...windowOptions,
      show: false,
      frame: true,
      titleBarStyle: "default",
      titleBarOverlay: false,
      autoHideMenuBar: true,
      webPreferences: {
        partition: "nuwax-browser-ui",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload:
          options.preloadPath ??
          path.join(__dirname, "..", "preload", "browserWindow.js"),
      },
    });
    let page: PageView;
    try {
      page = new PageView(win, { webContents: options.guest, webPreferences });
    } catch (error) {
      win.destroy();
      throw error;
    }
    const wc = page.webContents;
    const entry: Entry = {
      window: win,
      contents: wc,
      page,
      toolbarUrl,
      toolbarReady: false,
      showing: false,
      hasDocument: false,
      query: "",
      findRequest: -1,
      state: {
        title: "",
        url: options.initialUrl ?? "",
        domain: "",
        loading: true,
        canGoBack: false,
        canGoForward: false,
        zoom: 100,
        pinned: false,
        error: null,
        finding: false,
        matches: 0,
        activeMatch: 0,
        labels: labels(),
        dark: false,
      },
    };
    const toolbarId = win.webContents.id;
    entries.set(toolbarId, entry);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-redirect", (event) => event.preventDefault());
    win.webContents.once("did-finish-load", () => {
      entry.toolbarReady = true;
      push(entry);
      show(entry);
    });
    wc.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (!mainFrame) return;
      if (webUrl(url)) entry.state.url = url;
      if (!inPlace) {
        entry.state.error = null;
        entry.query = "";
        entry.findRequest = -1;
        entry.state.matches = entry.state.activeMatch = 0;
        page.view.setVisible(true);
      }
      push(entry);
    });
    wc.on("did-navigate", () => {
      entry.hasDocument = true;
      push(entry);
    });
    const update = () => push(entry);
    wc.on("did-start-loading", update);
    wc.on("did-stop-loading", update);
    wc.on("page-title-updated", update);
    wc.on("did-navigate-in-page", update);
    wc.on("dom-ready", () => {
      push(entry);
      show(entry);
    });
    wc.on("did-finish-load", () => {
      entry.hasDocument = true;
      push(entry);
      show(entry);
    });
    wc.on("did-fail-load", (_event, code, _description, url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      entry.state.url = webUrl(url) ?? entry.state.url;
      entry.state.error = entry.state.labels.failed;
      page.view.setVisible(false);
      push(entry);
      show(entry);
    });
    wc.on("render-process-gone", () => {
      entry.state.error = entry.state.labels.failed;
      page.view.setVisible(false);
      push(entry);
      show(entry);
    });
    wc.on("found-in-page", (_event, result) => {
      if (result.requestId !== entry.findRequest) return;
      entry.state.matches = result.matches;
      entry.state.activeMatch = result.activeMatchOrdinal;
      push(entry);
    });
    const shortcuts = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown") return;
      let type: BrowserCommand["type"] | undefined;
      const key = input.key.toLowerCase();
      if ((input.control || input.meta) && !input.alt)
        type = (
          {
            r: "reload",
            f: "find-open",
            p: "print",
            "+": "zoom-in",
            "=": "zoom-in",
            "-": "zoom-out",
            "0": "zoom-reset",
            "[": "back",
            "]": "forward",
          } as const
        )[key];
      else if (key === "f5") type = "reload";
      else if (input.alt && key === "arrowleft") type = "back";
      else if (input.alt && key === "arrowright") type = "forward";
      else if (key === "escape" && entry.state.finding) type = "find-close";
      if (type) {
        event.preventDefault();
        void execute(entry, { type } as BrowserCommand).catch(() =>
          ctx.log.warn("[Browser] Shortcut failed")
        );
      }
    };
    wc.on("before-input-event", shortcuts);
    win.webContents.on("before-input-event", shortcuts);
    win.on("close", (event) => {
      if (!wc.isDestroyed()) {
        event.preventDefault();
        wc.close({ waitForBeforeUnload: true });
      }
    });
    const cleanup = () => {
      entries.delete(toolbarId);
      page.destroy();
      if (!win.isDestroyed()) win.destroy();
    };
    wc.once("destroyed", cleanup);
    win.once("closed", cleanup);
    void win.loadURL(toolbarUrl).catch(() => {
      if (win.isDestroyed() || wc.isDestroyed()) return;
      ctx.log.warn("[Browser] Toolbar failed to load");
      const url = webUrl(entry.state.url);
      if (url)
        void shell
          .openExternal(url)
          .catch(() =>
            ctx.log.warn("[Browser] System-browser fallback failed")
          );
      cleanup();
    });
    return { window: win, contents: wc };
  };
  const closeAll = () => {
    for (const entry of [...entries.values()]) entry.window.destroy();
  };
  return {
    open,
    closeAll,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      closeAll();
      nativeTheme.removeListener("updated", refresh);
      ipcMain.removeHandler(BROWSER_IPC.state);
      ipcMain.removeHandler(BROWSER_IPC.command);
    },
  };
}
