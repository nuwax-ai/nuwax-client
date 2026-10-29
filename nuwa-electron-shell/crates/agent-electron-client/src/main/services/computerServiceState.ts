import type { WebContents } from "electron";
import {
  parseComputerServiceStateCommand,
  type ComputerServiceStateCommand,
} from "@shared/types/computerServiceState";

interface ComputerServiceStateBridgeOptions {
  getState(): ComputerServiceStateCommand;
  /** 每次发送重新检查产品、会话与当前文档 origin，导航前的信任不可沿用。 */
  canSend(contents: WebContents): boolean;
}

/** 生命周期 → 商业业务文档；独立于壳 renderer，重载同步同一最新快照。 */
export function createComputerServiceStateBridge(options: ComputerServiceStateBridgeOptions) {
  const cleanups = new Map<WebContents, () => void>();
  const detach = (contents: WebContents) => {
    cleanups.get(contents)?.();
    cleanups.delete(contents);
  };
  const sync = (contents: WebContents) => {
    if (!cleanups.has(contents)) return;
    if (contents.isDestroyed()) {
      detach(contents);
      return;
    }
    try {
      if (!options.canSend(contents)) return;
      const payload = parseComputerServiceStateCommand(options.getState());
      if (!payload) return;
      contents.send("nuwax:host-command", payload);
    } catch {
      // 发送期间导航/销毁不能阻断注册与服务生命周期。
    }
  };
  return {
    attach(contents: WebContents): void {
      if (contents.isDestroyed() || cleanups.has(contents)) return;
      const loaded = () => sync(contents);
      const destroyed = () => detach(contents);
      contents.on("dom-ready", loaded);
      contents.once("destroyed", destroyed);
      cleanups.set(contents, () => {
        contents.removeListener("dom-ready", loaded);
        contents.removeListener("destroyed", destroyed);
      });
    },
    sync,
    broadcast(): void {
      for (const contents of [...cleanups.keys()]) sync(contents);
    },
  };
}
