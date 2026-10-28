import { describe, expect, it, vi } from "vitest";
import { createDistHandshakeReader } from "./distVersionHandshakeIPC";

const snapshot = { backendOrigin: "https://a.example", bundled: null, cloud: null, relation: "different" as const, checkedAt: 100 };

describe("private snapshot IPC context", () => {
  it("uses the configured backend/session and the authoritative running gateway", async () => {
    const getSnapshot = vi.fn(async () => snapshot);
    const read = createDistHandshakeReader({
      handshake: { getSnapshot }, backendOrigin: () => "https://a.example", sessionEpoch: () => 7,
      gatewayStatus: () => ({ running: true, origin: "http://127.0.0.1:46800", mode: "dist" }),
    });
    expect(await read(true)).toMatchObject({ relation: "different", gateway: { mode: "dist", origin: "http://127.0.0.1:46800" } });
    expect(getSnapshot).toHaveBeenCalledWith("https://a.example", { force: true, scope: 7 });
  });
  it.each(["origin", "session"])("drops a result if its %s changed while checking", async change => {
    let origin = "https://a.example", epoch = 7;
    let finish!: (value: typeof snapshot) => void;
    const read = createDistHandshakeReader({
      handshake: { getSnapshot: () => new Promise(resolve => { finish = resolve; }) },
      backendOrigin: () => origin, sessionEpoch: () => epoch, gatewayStatus: () => ({ running: false }),
    });
    const pending = read();
    if (change === "origin") origin = "https://b.example"; else epoch++;
    finish(snapshot);
    expect(await pending).toEqual({ backendOrigin: "", bundled: null, cloud: null, relation: "unknown", checkedAt: null, gateway: null });
  });
  it("does not describe a stopped gateway as bundled mode", async () => {
    const read = createDistHandshakeReader({
      handshake: { getSnapshot: async () => snapshot }, backendOrigin: () => "https://a.example", sessionEpoch: () => 7,
      gatewayStatus: () => ({ running: false, origin: "http://127.0.0.1:46800", mode: "dist" }),
    });
    expect((await read()).gateway).toBeNull();
  });

  it("does not fetch the gateway's bundled version.json as cloud evidence", async () => {
    const getSnapshot = vi.fn();
    const read = createDistHandshakeReader({
      handshake: { getSnapshot }, backendOrigin: () => "http://127.0.0.1:46800/", sessionEpoch: () => 7,
      gatewayStatus: () => ({ running: true, origin: "http://127.0.0.1:46800", mode: "dist" }),
    });
    expect(await read()).toMatchObject({ relation: "unknown", cloud: null, checkedAt: null });
    expect(getSnapshot).not.toHaveBeenCalled();
  });
});
