import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: { request: mock.request } }));
import { probeServerHost } from "./serverHostProbe";

afterEach(() => { vi.useRealTimers(); mock.request.mockReset(); });

describe("service address preflight", () => {
  it.each(["response", "redirect"])("accepts an HTTP %s without credentials or following redirects", async (event) => {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), abort: vi.fn() });
    mock.request.mockReturnValue(req);
    const result = probeServerHost("https://intranet");
    expect(mock.request).toHaveBeenCalledWith({ url: "https://intranet", method: "HEAD", credentials: "omit", redirect: "manual" });
    req.emit(event);
    expect(await result).toBe("ok");
    expect(req.abort).toHaveBeenCalledOnce();
  });
  it("distinguishes a DNS error and bounds an unresponsive proxy", async () => {
    vi.useFakeTimers();
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), abort: vi.fn() });
    mock.request.mockReturnValue(req);
    const dns = probeServerHost("https://missing.example");
    req.emit("error", new Error("net::ERR_NAME_NOT_RESOLVED"));
    expect(await dns).toBe("dns");
    const pending = probeServerHost("https://intranet");
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBe("unreachable");
  });
});
