import { describe, expect, it, vi } from "vitest";
import { createExternalOpenHandler, externalWebUrl, isExternalOpenSender } from "./openExternal";

const entry = "file:///C:/Nuwax/resources/app.asar/dist/index.html";
function fixture(url = entry) {
  const mainFrame = { url };
  const host = { mainFrame, getURL: () => url, isDestroyed: () => false };
  return { host, event: { sender: host, senderFrame: mainFrame } };
}
describe("external-open boundary", () => {
  it.each(["file:///C:/run.exe", "javascript:void(0)", "data:text/html,test", "ms-msdt:/test", "powershell:run", "cmd:run", "mailto:test@example.com", "https:example.com", "https:\\example.com", " https://example.com", "https://example.com/\nvalue", "invalid", null, {}, "https://example.com/" + "a".repeat(8192)])("rejects non-web or malformed input %s", (value) => {
    expect(externalWebUrl(value)).toBeNull();
  });
  it("keeps valid webpage links", async () => {
    const { host, event } = fixture(); const open = vi.fn().mockResolvedValue(undefined);
    expect(await createExternalOpenHandler(() => host as never, entry, open)(event as never, "HTTPS://EXAMPLE.COM/docs?q=test#source"))
      .toEqual({ success: true });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("https://example.com/docs?q=test#source");
  });
  it("rejects foreign windows, subframes and navigated host documents before calling the OS", async () => {
    const { host, event } = fixture(); const open = vi.fn();
    const handle = createExternalOpenHandler(() => host as never, entry, open);
    for (const caller of [{ ...event, sender: {} }, { ...event, senderFrame: { url: entry } }, fixture("https://example.com/").event]) {
      expect((await handle(caller as never, "https://example.com/")).success).toBe(false);
    }
    const changed = fixture("file:///C:/other.html");
    expect(isExternalOpenSender(changed.event as never, changed.host as never, entry)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("requires the configured development origin and live host", () => {
    const { host, event } = fixture("http://localhost:5173/settings");
    expect(isExternalOpenSender(event as never, host as never, "http://localhost:5173/")).toBe(true);
    expect(isExternalOpenSender(event as never, host as never, "http://localhost:5174/")).toBe(false);
    host.isDestroyed = () => true;
    expect(isExternalOpenSender(event as never, host as never, "http://localhost:5173/")).toBe(false);
  });
  it("rejects unsafe URLs and returns OS failure without echoing its input", async () => {
    const { host, event } = fixture(); const open = vi.fn().mockRejectedValue(Error("OS failure containing a supplied URL"));
    const handle = createExternalOpenHandler(() => host as never, entry, open);
    expect((await handle(event as never, "file:///C:/run.exe")).success).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(await handle(event as never, "https://example.com/")).toEqual({ success: false, error: "Unable to open external webpage" });
  });
});
