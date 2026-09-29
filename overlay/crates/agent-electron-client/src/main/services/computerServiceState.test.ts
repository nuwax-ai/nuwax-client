import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createComputerServiceStateBridge } from "./computerServiceState";

function document() {
  const events = new EventEmitter();
  return Object.assign(events, {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send: vi.fn(),
  });
}

describe("商业电脑状态文档同步", () => {
  it("只向已登记且当前受信文档广播，重载读取最新快照并去掉凭据", () => {
    const guest = document();
    const unknown = document();
    let trusted = true;
    let phase = "starting";
    const bridge = createComputerServiceStateBridge({
      getState: () => ({ type: "computer-service-state", phase, sandboxId: "31", ticket: "secret", configKey: "secret" }),
      canSend: () => trusted,
    });
    bridge.attach(guest as unknown as WebContents);
    bridge.attach(guest as unknown as WebContents);
    expect(guest.listenerCount("dom-ready")).toBe(1);
    bridge.sync(unknown as unknown as WebContents);
    expect(unknown.send).not.toHaveBeenCalled();
    guest.emit("dom-ready");
    expect(guest.send).toHaveBeenLastCalledWith("nuwax:host-command", {
      type: "computer-service-state", phase: "starting", sandboxId: "31",
    });
    phase = "ready";
    trusted = false;
    bridge.broadcast();
    expect(guest.send).toHaveBeenCalledOnce();
    trusted = true;
    guest.emit("dom-ready");
    expect(guest.send).toHaveBeenLastCalledWith("nuwax:host-command", {
      type: "computer-service-state", phase: "ready", sandboxId: "31",
    });
  });

  it("销毁移除监听和广播目标，单个文档发送失败不影响其他文档", () => {
    const broken = document();
    const surviving = document();
    const bridge = createComputerServiceStateBridge({
      getState: () => ({ type: "computer-service-state", phase: "ready" }),
      canSend: () => true,
    });
    bridge.attach(broken as unknown as WebContents);
    bridge.attach(surviving as unknown as WebContents);
    broken.send.mockImplementation(() => { throw new Error("destroyed during send"); });
    expect(() => bridge.broadcast()).not.toThrow();
    expect(surviving.send).toHaveBeenCalledOnce();
    broken.destroyed = true;
    broken.emit("destroyed");
    expect(broken.listenerCount("dom-ready")).toBe(0);
    bridge.broadcast();
    expect(broken.send).toHaveBeenCalledOnce();
    expect(surviving.send).toHaveBeenCalledTimes(2);
  });

  it("信任/快照 getter 异常不会阻断其他 guest 的生命周期通知", () => {
    const badTrust = document();
    const badSnapshot = document();
    const survivor = document();
    let current: typeof badTrust | null = null;
    const bridge = createComputerServiceStateBridge({
      getState: () => {
        if (current === badSnapshot) throw new Error("database temporarily unavailable");
        return { type: "computer-service-state", phase: "ready" };
      },
      canSend: (contents) => {
        current = contents as unknown as typeof badTrust;
        if (current === badTrust) throw new Error("navigated during trust check");
        return true;
      },
    });
    for (const guest of [badTrust, badSnapshot, survivor]) bridge.attach(guest as unknown as WebContents);
    expect(() => bridge.broadcast()).not.toThrow();
    expect(badTrust.send).not.toHaveBeenCalled();
    expect(badSnapshot.send).not.toHaveBeenCalled();
    expect(survivor.send).toHaveBeenCalledOnce();
  });
});
