import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({}));
import { browserWindowChrome, isBrowserToolbar } from "./windows";
describe("browser window chrome", () => {
  it("keeps only native traffic lights on macOS, inside the toolbar", () => {
    expect(browserWindowChrome("darwin")).toMatchObject({
      frame: true,
      titleBarStyle: "hidden",
      titleBarOverlay: false,
      trafficLightPosition: { x: 16, y: 11 },
    });
  });
  it.each(["win32", "linux"] as const)(
    "removes the native title bar on %s so the toolbar owns the right-hand controls",
    (platform) => {
      expect(browserWindowChrome(platform)).toMatchObject({
        frame: false,
        titleBarStyle: "default",
        titleBarOverlay: false,
      });
      expect(browserWindowChrome(platform)).not.toHaveProperty(
        "trafficLightPosition",
      );
    },
  );
});
describe("browser toolbar ownership", () => {
  it("only accepts the owned local main frame, rejecting pages, subframes and navigated toolbars", () => {
    const url = "file:///app/browser.html";
    const mainFrame = { url };
    const toolbar = {
      mainFrame,
      getURL: () => mainFrame.url,
      isDestroyed: () => false,
    };
    const entry = {
      window: { webContents: toolbar, isDestroyed: () => false },
      toolbarUrl: url,
    } as never;
    expect(
      isBrowserToolbar(
        { sender: toolbar, senderFrame: mainFrame } as never,
        entry,
      ),
    ).toBe(true);
    expect(
      isBrowserToolbar(
        { sender: toolbar, senderFrame: { url } } as never,
        entry,
      ),
    ).toBe(false);
    expect(
      isBrowserToolbar(
        { sender: { ...toolbar }, senderFrame: mainFrame } as never,
        entry,
      ),
    ).toBe(false);
    mainFrame.url = "https://external.example/";
    expect(
      isBrowserToolbar(
        { sender: toolbar, senderFrame: mainFrame } as never,
        entry,
      ),
    ).toBe(false);
  });
});
