import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IM_IPC_CHANNELS, type IMUnreadSnapshot } from "@shared/types/imReceiver";
import { registerIMUnreadBridge } from "./imUnreadBridge";

function setup() {
  const snapshot = {sessionGeneration: 2, revision: 3, total: 126, dndTotal: 0};
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  let publish!: (value: IMUnreadSnapshot | null) => void;
  const allowed = new Set<IpcMainInvokeEvent>();
  registerIMUnreadBridge({
    ipc: {handle: (channel, handler) => { handlers.set(channel, handler); }},
    isAllowed: event => allowed.has(event), getSnapshot: () => snapshot,
    onChange: listener => { publish = listener; return () => {}; },
  });
  let id = 0;
  const guest = () => {
    const frame = {url: "https://business.example/home"};
    const sender = Object.assign(new EventEmitter(), {
      id: ++id, mainFrame: frame, isDestroyed: vi.fn(() => false), send: vi.fn(),
    });
    const event = {sender, senderFrame: frame} as unknown as IpcMainInvokeEvent;
    return {event, sender};
  };
  const read = (event: IpcMainInvokeEvent) => handlers.get(IM_IPC_CHANNELS.UNREAD_SNAPSHOT)!(event);
  return {snapshot, allowed, publish: (value: IMUnreadSnapshot | null) => publish(value), guest, read};
}

describe("IM read-only snapshot IPC", () => {
  it("late mounting reads the existing count without starting another receiver; multiple reads have one target", () => {
    const h = setup(); const g = h.guest(); h.allowed.add(g.event);
    expect(h.read(g.event)).toEqual(h.snapshot);
    h.read(g.event);
    h.publish({...h.snapshot, revision: 4, total: 1});
    expect(g.sender.send).toHaveBeenCalledTimes(1);
    expect(g.sender.send).toHaveBeenLastCalledWith(IM_IPC_CHANNELS.UNREAD_CHANGED, {...h.snapshot, revision: 4, total: 1});
    expect(g.sender.listenerCount("destroyed")).toBe(1);
    h.publish(null);
    expect(g.sender.send).toHaveBeenLastCalledWith(IM_IPC_CHANNELS.UNREAD_CHANGED, null);
  });

  it("untrusted, child or old-account documents rejected by the auth gate never enroll", () => {
    const h = setup(); const g = h.guest();
    expect(h.read(g.event)).toBeNull(); h.publish(h.snapshot);
    expect(g.sender.send).not.toHaveBeenCalled();
  });

  it.each(["auth", "navigation", "destroyed"])("rechecks %s before every push and allows fresh enrollment", reason => {
    const h = setup(); const g = h.guest(); h.allowed.add(g.event); h.read(g.event);
    if (reason === "auth") h.allowed.delete(g.event);
    if (reason === "navigation") g.sender.mainFrame = {url: "https://other.example"};
    if (reason === "destroyed") { g.sender.isDestroyed.mockReturnValue(true); g.sender.emit("destroyed"); }
    h.publish(h.snapshot); expect(g.sender.send).not.toHaveBeenCalled();
    g.sender.mainFrame = g.event.senderFrame as typeof g.sender.mainFrame;
    g.sender.isDestroyed.mockReturnValue(false); h.allowed.add(g.event);
    h.read(g.event); h.publish(h.snapshot);
    expect(g.sender.send).toHaveBeenCalledTimes(1);
    expect(g.sender.listenerCount("destroyed")).toBeLessThanOrEqual(1);
  });

  it("one disappearing frame does not prevent another current document receiving changes", () => {
    const h = setup(); const a = h.guest(); const b = h.guest();
    for (const g of [a,b]) { h.allowed.add(g.event); h.read(g.event); }
    a.sender.send.mockImplementation(() => { throw new Error("frame gone"); });
    h.publish(h.snapshot); h.publish(null);
    expect(a.sender.send).toHaveBeenCalledTimes(1);
    expect(b.sender.send).toHaveBeenCalledTimes(2);
  });
});
