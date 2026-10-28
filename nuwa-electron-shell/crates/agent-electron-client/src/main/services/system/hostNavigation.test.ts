import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { guardHostNavigation, isHostNavigationAllowed } from "./hostNavigation";

const entry = "file:///C:/Program%20Files/Nuwax/resources/app.asar/dist/index.html";
describe("privileged host navigation", () => {
  it("retains renderer query/hash routes and rejects other documents or protocols", () => {
    expect(isHostNavigationAllowed(`${entry}?language=zh#settings`, entry)).toBe(true);
    for (const target of ["https://testagent.xspaceagi.com", "https://example.com", "file:///C:/other.html", "file://server/share/index.html", "javascript:void(0)", "data:text/html,test", "about:blank", "invalid"]) {
      expect(isHostNavigationAllowed(target, entry)).toBe(false);
    }
  });
  it("limits development to the configured loopback origin", () => {
    const dev = "http://localhost:5173/";
    expect(isHostNavigationAllowed("http://localhost:5173/settings#test", dev)).toBe(true);
    for (const target of ["http://localhost:5174/", "http://127.0.0.1:5173/", "https://localhost:5173/", "http://localhost:5173.evil.test/"]) {
      expect(isHostNavigationAllowed(target, dev)).toBe(false);
    }
    expect(isHostNavigationAllowed("https://example.com/", "https://example.com/")).toBe(false);
  });
  it("blocks top-frame navigation and redirects without restricting embedded business pages", () => {
    const contents = new EventEmitter();
    guardHostNavigation(contents as unknown as WebContents, entry);
    for (const eventName of ["will-frame-navigate", "will-redirect"]) {
      const preventDefault = vi.fn();
      contents.emit(eventName, { url: "https://example.com/", isMainFrame: true, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      preventDefault.mockClear();
      contents.emit(eventName, { url: "https://example.com/", isMainFrame: false, preventDefault });
      contents.emit(eventName, { url: `${entry}#settings`, isMainFrame: true, preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
    }
  });
});
