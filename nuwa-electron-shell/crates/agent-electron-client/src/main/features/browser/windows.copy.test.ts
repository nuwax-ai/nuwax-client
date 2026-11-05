import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_IPC } from "@shared/features/browser/contract";
import { publicWebUrl } from "@shared/utils/publicWebUrl";
import type { FeatureContext } from "../_kit/types";
import { createBrowserWindows } from "./windows";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  writeText: vi.fn(),
  openExternal: vi.fn(async () => {}),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    BrowserWindow: class extends EventEmitter {
      private destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        id: 11,
        mainFrame: { url: "" },
        isDestroyed: () => false,
        getURL: () => this.webContents.mainFrame.url,
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
      });
      loadURL = async (url: string) => {
        this.webContents.mainFrame.url = url;
      };
      isDestroyed = () => this.destroyed;
      isAlwaysOnTop = () => false;
      isMaximized = () => false;
      isFullScreen = () => false;
      destroy() {
        this.destroyed = true;
        this.emit("closed");
      }
    },
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => any) =>
        state.handlers.set(name, handler),
      removeHandler: (name: string) => state.handlers.delete(name),
    },
    clipboard: { writeText: state.writeText },
    shell: { openExternal: state.openExternal },
    nativeTheme: Object.assign(new EventEmitter(), {
      shouldUseDarkColors: false,
    }),
  };
});
vi.mock("./vendor/pageView", () => ({
  PageView: class {
    webContents: unknown;
    view = { setVisible: vi.fn() };
    invalidateLayout = vi.fn();
    destroy = vi.fn();
    constructor(_window: unknown, options: { webContents: unknown }) {
      this.webContents = options.webContents;
    }
  },
}));

let browser: ReturnType<typeof createBrowserWindows> | undefined;
afterEach(() => {
  browser?.dispose();
  browser = undefined;
  vi.clearAllMocks();
});

function open(
  url: string,
  businessOrigin: string | undefined = "https://business.example"
) {
  const context = {
    windows: {
      getMain: () => ({
        webContents: { getURL: () => "file:///app/index.html" },
      }),
      toExternalUrl: (value: string) =>
        publicWebUrl(value, {
          businessOrigin,
          gatewayOrigin: "http://127.0.0.1:45678",
        }),
    },
    settings: { read: () => undefined },
    log: { warn: vi.fn() },
  } as unknown as FeatureContext;
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => url,
    getTitle: () => "Document",
    isDestroyed: () => false,
    isLoading: () => false,
    getZoomFactor: () => 1,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  });
  browser = createBrowserWindows(context);
  const page = browser.open({
    windowOptions: {},
    initialUrl: url,
    guest: contents as never,
  });
  const sender = page.window.webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  return (type: "copy" | "external") =>
    state.handlers.get(BROWSER_IPC.command)!(event, { type });
}

describe("browser copy action", () => {
  it("copies the same public business link used by the external-browser action", async () => {
    const run = open(
      "http://127.0.0.1:45678/repo/doc/one?hide_sheet=true&_shell=1#section"
    );
    expect(await run("copy")).toBe(true);
    expect(state.writeText).toHaveBeenCalledWith(
      "https://business.example/repo/doc/one?hide_sheet=true#section"
    );
    expect(await run("external")).toBe(true);
    expect(state.openExternal).toHaveBeenCalledWith(
      state.writeText.mock.calls[0][0]
    );
  });
  it("does not export an unmapped local gateway link", async () => {
    const run = open("http://127.0.0.1:45678/repo/doc/one", "");
    expect(await run("copy")).toBe(false);
    expect(state.writeText).not.toHaveBeenCalled();
  });
  it("keeps normal external links and their share parameters", async () => {
    const url = "https://external.example/doc?share=read-only#section";
    expect(await open(url)("copy")).toBe(true);
    expect(state.writeText).toHaveBeenCalledWith(url);
  });
  it("rejects embedded credentials even when the owned toolbar asks to copy", async () => {
    expect(await open("https://user:secret@external.example/doc")("copy")).toBe(
      false
    );
    expect(state.writeText).not.toHaveBeenCalled();
  });
});
