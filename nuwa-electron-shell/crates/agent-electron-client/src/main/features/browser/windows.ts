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
  BROWSER_TOOLBAR_HEIGHT,
  BROWSER_AUXILIARY_BAR_HEIGHT,
  type BrowserCommand,
  type BrowserState,
} from "@shared/features/browser/contract";
import type { FeatureContext } from "../_kit/types";
import { PageView } from "./vendor/pageView";
import { confirmBrowserCertificates } from "./certificates";

export interface BrowserPageOptions {
  windowOptions: BrowserWindowConstructorOptions;
  initialUrl?: string;
  /** Host supplies the existing Chromium popup guest, including its opener/POST navigation. */
  guest?: WebContents;
  toolbarUrl?: string;
  preloadPath?: string;
  /** Payment flows need their own window; ordinary pages share a tabbed window. */
  isolated?: boolean;
}
export interface BrowserPage {
  window: BrowserWindow;
  contents: WebContents;
  /** Host cleanup must affect this page rather than sibling tabs. */
  destroy(): void;
  hide(): void;
}
type WindowEntry = {
  window: BrowserWindow;
  toolbarUrl: string;
  tabs: Entry[];
  active: Entry | null;
  toolbarReady: boolean;
  showing: boolean;
  isolated: boolean;
  closing: boolean;
  disposed: boolean;
  feedbackSequence: number;
  baseListenerLimit: number;
};
type Entry = {
  window: BrowserWindow;
  contents: WebContents;
  group: WindowEntry;
  page: PageView;
  state: BrowserState;
  hasDocument: boolean;
  findRequest: number;
  query: string;
  suppressed: boolean;
  shortcuts?: (event: Electron.Event, input: Electron.Input) => void;
  dispose(): void;
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
  "copyFailed",
  "printFailed",
  "url",
] as const;

/** Ordinary tabs and isolated payment windows use the same window chrome. */
export function browserWindowChrome(
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions {
  return {
    frame: platform === "darwin",
    titleBarStyle: platform === "darwin" ? "hidden" : "default",
    titleBarOverlay: false,
    ...(platform === "darwin"
      ? {
          trafficLightPosition: { x: 16, y: (BROWSER_TOOLBAR_HEIGHT - 14) / 2 },
        }
      : {}),
    hasShadow: true,
    autoHideMenuBar: true,
  };
}

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
  entry: { window: BrowserWindow; toolbarUrl: string },
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
  const windows = new Map<number, WindowEntry>();
  let shared: WindowEntry | null = null;
  let disposed = false;
  const publicUrl = (value: string) => ctx.windows.toExternalUrl
    ? ctx.windows.toExternalUrl(value) : webUrl(value);
  const labels = (): Record<string, string> => ({
    loading: ctx.translate?.("Claw.Common.loading") ?? "Loading…",
    ...Object.fromEntries(
      LABELS.map((key) => [key, ctx.translate?.(`Claw.Browser.${key}`) ?? key]),
    ),
    ...Object.fromEntries(
      ["minimize", "maximize", "restore"].map((key) => [
        key,
        ctx.translate?.(`Claw.Toolbar.${key}`) ?? key,
      ]),
    ),
  });
  const updateState = (entry: Entry) => {
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
    entry.state.initialLoading =
      entry.state.loading && !entry.hasDocument && !entry.state.error;
    entry.state.findText = entry.query;
    entry.state.zoom = Math.round(wc.getZoomFactor() * 100);
    entry.state.pinned = entry.window.isAlwaysOnTop();
    entry.state.maximized = entry.window.isMaximized();
    entry.state.fullscreen = entry.window.isFullScreen();
    entry.state.labels = labels();
    const theme = ctx.settings.read("theme_mode") ?? "system";
    entry.state.dark =
      theme === "dark" ||
      (theme === "system" && nativeTheme.shouldUseDarkColors);
  };
  const snapshot = (group: WindowEntry): BrowserState | null => {
    if (!group.active || group.disposed) return null;
    updateState(group.active);
    return {
      ...group.active.state,
      activeTabId: group.active.contents.id,
      tabs: group.tabs.map((tab) => ({
        id: tab.contents.id,
        title: tab.state.title || tab.state.domain || tab.state.labels.loading,
        loading: tab.state.loading,
      })),
    };
  };
  const push = (entry: Entry) => {
    updateState(entry);
    const group = entry.group;
    const state = snapshot(group);
    if (state && group.toolbarReady && !group.window.isDestroyed())
      group.window.webContents.send(BROWSER_IPC.changed, state);
  };
  const show = (entry: Entry) => {
    const group = entry.group;
    if (
      group.active === entry &&
      !entry.suppressed &&
      !group.showing &&
      group.toolbarReady &&
      !entry.window.isDestroyed() &&
      !entry.contents.isDestroyed() &&
      (entry.hasDocument ||
        entry.state.error ||
        (entry.state.loading && webUrl(entry.state.url)))
    ) {
      group.showing = true;
      entry.window.show();
      entry.window.focus();
    }
  };
  const visible = (entry: Entry) => {
    entry.page.view.setVisible(
      entry.group.active === entry && entry.hasDocument && !entry.state.error,
    );
  };
  const layout = (entry: Entry) => {
    entry.page.toolbarHeight =
      BROWSER_TOOLBAR_HEIGHT +
      BROWSER_AUXILIARY_BAR_HEIGHT *
        (Number(entry.state.finding) + Number(entry.state.addressOpen));
    entry.page.invalidateLayout();
  };
  const activate = (entry: Entry, focus = true) => {
    const group = entry.group;
    entry.suppressed = false;
    group.active = entry;
    for (const tab of group.tabs) visible(tab);
    layout(entry);
    push(entry);
    show(entry);
    if (focus && !entry.contents.isDestroyed()) {
      if (entry.state.finding || entry.state.addressOpen) group.window.webContents.focus();
      else entry.contents.focus();
    }
  };
  const findOpen = (entry: Entry, enabled: boolean) => {
    entry.state.finding = enabled;
    layout(entry);
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
    const target = publicUrl(entry.state.url);
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
    command: BrowserCommand,
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
        const pendingUrl =
          (entry.state.error || !entry.hasDocument) && webUrl(entry.state.url);
        entry.state.error = null;
        visible(entry);
        if (pendingUrl) void wc.loadURL(pendingUrl).catch(() => {});
        else wc.reload();
        break;
      }
      case "stop":
        wc.stop();
        break;
      case "copy": {
        // 与系统浏览器交接共用业务地址，不能把仅本机可用的网关链接放进剪贴板。
        const url = publicUrl(entry.state.url);
        let success = false;
        try {
          if (url) {
            clipboard.writeText(url);
            success = true;
          }
        } catch {
          ctx.log.warn("[Browser] Clipboard write failed");
        }
        entry.state.copyFeedback = {
          id: ++entry.group.feedbackSequence,
          success,
        };
        push(entry);
        return success;
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
        entry.state.findFocusRequest++;
        entry.window.webContents.focus();
        break;
      case "find-close":
        findOpen(entry, false);
        break;
      case "address-open":
      case "address-close":
        entry.state.addressOpen = command.type === "address-open";
        layout(entry);
        break;
      case "window-minimize":
        if (!entry.window.isMinimizable()) return false;
        entry.window.minimize();
        break;
      case "window-maximize":
        if (entry.window.isFullScreen()) entry.window.setFullScreen(false);
        else if (!entry.window.isMaximizable()) return false;
        else if (entry.window.isMaximized()) entry.window.unmaximize();
        else entry.window.maximize();
        break;
      case "window-close":
        if (!entry.window.isClosable()) return false;
        // Keep the host's remote-page beforeunload/download cleanup path.
        entry.window.close();
        return true;
      case "tab-activate":
      case "tab-close": {
        if (!Number.isSafeInteger(command.id)) return false;
        const tab = entry.group.tabs.find((item) => item.contents.id === command.id);
        if (!tab || tab.contents.isDestroyed()) return false;
        if (command.type === "tab-activate") activate(tab);
        else tab.contents.close({ waitForBeforeUnload: true });
        return true;
      }
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
            ctx.log.warn("[Browser] Menu action failed"),
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
            label: l.find,
            accelerator: "CmdOrCtrl+F",
            click: action("find-open"),
          },
          {
            label: l.print,
            accelerator: "CmdOrCtrl+P",
            click: action("print"),
          },
          { type: "separator" },
          { label: l.external, click: action("external") },
          { type: "separator" },
          {
            label: l[entry.window.isAlwaysOnTop() ? "unpin" : "pin"],
            type: "checkbox",
            checked: entry.window.isAlwaysOnTop(),
            click: action("pin"),
          },
        ]).popup({
          window: entry.window,
          x: Math.round(
            Math.max(
              0,
              Math.min(
                typeof command.x === "number" && Number.isFinite(command.x)
                  ? command.x
                  : 96,
                Math.max(0, entry.window.getContentSize()[0] - 240),
              ),
            ),
          ),
          y: BROWSER_TOOLBAR_HEIGHT,
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
    const group = windows.get(event.sender.id);
    return group && isBrowserToolbar(event, group) ? group : null;
  };
  const refresh = () => {
    for (const group of windows.values()) {
      for (const tab of group.tabs) updateState(tab);
      if (group.active) push(group.active);
    }
  };
  try {
    ipcMain.handle(BROWSER_IPC.state, (event) => {
      const group = owned(event);
      if (!group?.active) return null;
      push(group.active);
      return snapshot(group);
    });
    ipcMain.handle(
      BROWSER_IPC.command,
      async (event, command: BrowserCommand) => {
        const entry = owned(event)?.active;
        if (!entry) return false;
        try {
          return await execute(entry, command);
        } catch {
          ctx.log.warn("[Browser] Window action failed");
          return false;
        }
      },
    );
    nativeTheme.on("updated", refresh);
  } catch (error) {
    ipcMain.removeHandler(BROWSER_IPC.state);
    ipcMain.removeHandler(BROWSER_IPC.command);
    throw error;
  }

  const closeNext = (group: WindowEntry) => {
    const tab = group.active;
    if (!tab) {
      if (!group.window.isDestroyed()) group.window.destroy();
      return;
    }
    tab.contents.close({ waitForBeforeUnload: true });
  };
  const createWindow = (options: BrowserPageOptions, toolbarUrl: string): WindowEntry => {
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
      ...browserWindowChrome(),
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
    const group: WindowEntry = {
      window: win,
      toolbarUrl,
      tabs: [],
      active: null,
      toolbarReady: false,
      showing: false,
      isolated: options.isolated === true,
      closing: false,
      disposed: false,
      feedbackSequence: 0,
      baseListenerLimit: win.getMaxListeners(),
    };
    const toolbarId = win.webContents.id;
    windows.set(toolbarId, group);
    if (!group.isolated) shared = group;
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-redirect", (event) => event.preventDefault());
    win.webContents.once("did-finish-load", () => {
      group.toolbarReady = true;
      if (group.active) {
        push(group.active);
        show(group.active);
      }
    });
    const update = () => {
      if (group.active) push(group.active);
    };
    win.on("maximize", update);
    win.on("unmaximize", update);
    win.on("enter-full-screen", update);
    win.on("leave-full-screen", update);
    win.webContents.on("before-input-event", (event, input) => group.active?.shortcuts?.(event, input));
    win.on("close", (event) => {
      if (!group.tabs.length) return;
      event.preventDefault();
      if (group.closing) return;
      group.closing = true;
      closeNext(group);
    });
    win.once("closed", () => {
      group.disposed = true;
      windows.delete(toolbarId);
      if (shared === group) shared = null;
      for (const tab of [...group.tabs]) tab.dispose();
    });
    void win.loadURL(toolbarUrl).catch(() => {
      if (win.isDestroyed()) return;
      ctx.log.warn("[Browser] Toolbar failed to load");
      // A payment or authenticated business page must not fall out to the OS.
      void dialog.showMessageBox(win, {
        type: "error",
        message: labels().failed,
        buttons: [labels().close],
      }).catch(() => {}).finally(() => {
        if (!win.isDestroyed()) win.destroy();
      });
    });
    return group;
  };

  const open = (options: BrowserPageOptions): BrowserPage => {
    if (disposed) throw new Error("Browser feature is disposed");
    const parentEntry = ctx.windows.getMain()?.webContents.getURL();
    const toolbarUrl = options.toolbarUrl ??
      (parentEntry ? new URL("./browser.html", parentEntry).href : "");
    if (!toolbarUrl) throw new Error("Browser toolbar entry unavailable");
    const reused = !options.isolated && shared && !shared.disposed &&
      !shared.closing && !shared.window.isDestroyed() && shared.toolbarUrl === toolbarUrl
      ? shared : null;
    const group = reused ?? createWindow(options, toolbarUrl);
    const win = group.window;
    // Each live tab owns certificate, host-activity and popup cleanup listeners.
    // Keep the diagnostic limit proportional to live tabs and restore it on close.
    const listenerLimit = () => {
      if (group.baseListenerLimit !== 0)
        win.setMaxListeners(group.baseListenerLimit + group.tabs.length * 4);
    };
    if (group.baseListenerLimit !== 0)
      win.setMaxListeners(group.baseListenerLimit + (group.tabs.length + 1) * 4);
    const webPreferences = options.windowOptions.webPreferences;
    let page: PageView;
    try {
      page = new PageView(win, { webContents: options.guest, webPreferences });
    } catch (error) {
      listenerLimit();
      if (!reused) win.destroy();
      throw error;
    }
    const wc = page.webContents;
    const disposeCertificatePrompts = confirmBrowserCertificates(
      win,
      wc,
      (key) => ctx.translate?.(key) ?? key,
      options.initialUrl,
    );
    const entry: Entry = {
      window: win,
      contents: wc,
      group,
      page,
      hasDocument: !!webUrl(wc.getURL()),
      query: "",
      findRequest: -1,
      suppressed: false,
      dispose: () => {},
      state: {
        tabs: [],
        activeTabId: wc.id,
        title: "",
        url: options.initialUrl ?? "",
        domain: "",
        loading: true,
        initialLoading: true,
        canGoBack: false,
        canGoForward: false,
        zoom: 100,
        pinned: false,
        platform:
          process.platform === "darwin"
            ? "darwin"
            : process.platform === "win32"
              ? "win32"
              : "linux",
        maximized: false,
        fullscreen: false,
        addressOpen: false,
        error: null,
        finding: false,
        findText: "",
        findFocusRequest: 0,
        matches: 0,
        activeMatch: 0,
        labels: labels(),
        dark: false,
        copyFeedback: null,
      },
    };
    // The native page sits above the toolbar renderer. Keep about:blank hidden
    // so the local loading UI can paint while the server has not responded.
    page.view.setVisible(false);
    group.tabs.push(entry);
    wc.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (!mainFrame) return;
      if (webUrl(url)) entry.state.url = url;
      if (!inPlace) {
        entry.state.error = null;
        entry.query = "";
        entry.findRequest = -1;
        entry.state.matches = entry.state.activeMatch = 0;
        visible(entry);
      }
      push(entry);
      show(entry);
    });
    wc.on("did-navigate", () => {
      if (!webUrl(wc.getURL())) return;
      entry.hasDocument = true;
      visible(entry);
      push(entry);
      show(entry);
    });
    const update = () => {
      push(entry);
      show(entry);
    };
    wc.on("did-start-loading", update);
    wc.on("did-stop-loading", update);
    wc.on("page-title-updated", update);
    wc.on("did-navigate-in-page", update);
    wc.on("dom-ready", () => {
      push(entry);
      show(entry);
    });
    wc.on("did-finish-load", () => {
      entry.hasDocument ||= !!webUrl(wc.getURL());
      visible(entry);
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
      if ((input.control || input.meta) && !input.alt && key === "w") {
        event.preventDefault();
        void execute(entry, { type: "tab-close", id: entry.contents.id }).catch(() => {});
        return;
      }
      if (input.control && !input.alt && key === "tab") {
        event.preventDefault();
        const index = group.tabs.indexOf(entry);
        const next = (index + (input.shift ? -1 : 1) + group.tabs.length) % group.tabs.length;
        const tab = group.tabs[next];
        if (tab) activate(tab);
        return;
      }
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
      else if (key === "escape" && entry.state.addressOpen)
        type = "address-close";
      else if (key === "escape" && entry.state.finding) type = "find-close";
      if (type) {
        event.preventDefault();
        void execute(entry, { type } as BrowserCommand).catch(() =>
          ctx.log.warn("[Browser] Shortcut failed"),
        );
      }
    };
    wc.on("before-input-event", shortcuts);
    entry.shortcuts = shortcuts;
    wc.on("will-prevent-unload", (event) => {
      if (group.active !== entry) activate(entry, false);
      // The host's synchronous leave/stay handler runs on the same event.
      // Staying must also release the pending whole-window close request.
      setImmediate(() => {
        if (!event.defaultPrevented) group.closing = false;
      });
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      disposeCertificatePrompts();
      const index = group.tabs.indexOf(entry);
      if (index >= 0) group.tabs.splice(index, 1);
      page.destroy();
      listenerLimit();
      if (group.disposed) return;
      if (group.active === entry) group.active = group.tabs[Math.max(0, index - 1)] ?? null;
      if (!group.active) {
        if (!win.isDestroyed()) win.destroy();
      } else if (group.closing) {
        activate(group.active, false);
        closeNext(group);
      } else {
        activate(group.active, false);
      }
    };
    entry.dispose = cleanup;
    wc.once("destroyed", cleanup);
    activate(entry, false);
    if (reused && group.toolbarReady) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return {
      window: win,
      contents: wc,
      destroy: cleanup,
      hide() {
        entry.suppressed = true;
        const previous = group.tabs.find((tab) => tab !== entry && !tab.suppressed);
        if (group.active !== entry) return;
        if (previous) activate(previous, false);
        else {
          group.showing = false;
          win.hide();
        }
      },
    };
  };
  const closeAll = () => {
    for (const group of [...windows.values()]) group.window.destroy();
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
