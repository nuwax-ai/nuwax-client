import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({}));
import { isBrowserToolbar } from "./windows";
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
        entry
      )
    ).toBe(true);
    expect(
      isBrowserToolbar(
        { sender: toolbar, senderFrame: { url } } as never,
        entry
      )
    ).toBe(false);
    expect(
      isBrowserToolbar(
        { sender: { ...toolbar }, senderFrame: mainFrame } as never,
        entry
      )
    ).toBe(false);
    mainFrame.url = "https://external.example/";
    expect(
      isBrowserToolbar(
        { sender: toolbar, senderFrame: mainFrame } as never,
        entry
      )
    ).toBe(false);
  });
});
