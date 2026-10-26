import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ contents: [] as any[] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter(), webContents: { getAllWebContents: () => h.contents } };
});
import { app } from "electron";
import { conversationIdFromUrl, observeCuaConversation } from "./conversationContext";

class Contents extends EventEmitter {
  destroyed = false; trusted = true; url = "https://business.example/home/chat/101/7";
  constructor(public hostWebContents: unknown = null) { super(); }
  isDestroyed() { return this.destroyed; }
  getType() { return "webview"; }
  getURL() { return this.url; }
}
const observers: Array<ReturnType<typeof observeCuaConversation>> = [];
afterEach(() => { for (const observer of observers.splice(0)) observer.dispose(); h.contents = []; app.removeAllListeners(); });
describe("current conversation presentation context", () => {
  it.each([
    ["/home/chat/101/7", "101"], ["/app/chat/7/202", "202"],
    ["/space/1/app-pro/8/303", "303"], ["/space/1/agent-dev?agentId=7&conversationId=404", "404"],
    ["/#/home/chat/505/7", "505"], ["/home", null], ["/space/1/app-dev/8", null],
    ["/home/chat/-1/7", null], ["/home/chat/101/7/settings", null], ["/home?conversationId=101", null],
  ])("reads an explicit conversation from %s", (path, id) => {
    expect(conversationIdFromUrl("https://business.example" + path)).toBe(id);
  });
  it("follows only the main guest's top document and clears context during navigation", () => {
    const main = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false });
    const guest = new Contents(main.webContents); h.contents = [guest];
    const changed = vi.fn();
    const observer = observeCuaConversation({ getMainWindow: () => main as any,
      isCurrentDocument: contents => (contents as unknown as Contents).trusted, changed }); observers.push(observer);
    expect(observer.get()).toBe("101"); changed.mockClear();
    guest.url = "https://business.example/home/chat/202/7";
    guest.emit("did-navigate-in-page", {}, guest.url, false); expect(changed).not.toHaveBeenCalled();
    guest.emit("did-navigate-in-page", {}, guest.url, true); expect(observer.get()).toBe("202");
    expect(changed).toHaveBeenCalledOnce();
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(observer.get()).toBeNull();
    guest.trusted = false; guest.emit("did-navigate", {}, guest.url); expect(observer.get()).toBeNull();
    guest.trusted = true; guest.emit("dom-ready"); expect(observer.get()).toBe("202");
    guest.url = "https://business.example/home"; guest.emit("did-navigate-in-page", {}, guest.url, true);
    expect(observer.get()).toBeNull();
  });
  it("ignores independent windows and retired guests, including their late unloads", () => {
    const main = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false });
    const old = new Contents(main.webContents); h.contents = [old];
    const observer = observeCuaConversation({ getMainWindow: () => main as any, isCurrentDocument: () => true, changed: vi.fn() }); observers.push(observer);
    const popup = new Contents({}); popup.url = "https://business.example/home/chat/999/7";
    main.webContents.emit("did-attach-webview", {}, popup); expect(observer.get()).toBe("101");
    const replacement = new Contents(main.webContents); replacement.url = "https://business.example/app/chat/7/303";
    main.webContents.emit("did-attach-webview", {}, replacement); expect(observer.get()).toBe("303");
    old.url = "https://business.example/home"; old.emit("did-navigate-in-page", {}, old.url, true); old.emit("destroyed");
    expect(observer.get()).toBe("303");
    replacement.destroyed = true; replacement.emit("destroyed"); expect(observer.get()).toBeNull();
    observer.dispose(); expect(main.webContents.listenerCount("did-attach-webview")).toBe(0);
  });
});
