import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { IM_IPC_CHANNELS, type IMUnreadSnapshot } from "@shared/types/imReceiver";

/** 一个当前顶层文档对应一个目标；读快照同时登记，重载后不依赖下一次未读变化。 */
export function registerIMUnreadBridge(options: {
  ipc: Pick<IpcMain, "handle">;
  isAllowed(event: IpcMainInvokeEvent): boolean;
  getSnapshot(): IMUnreadSnapshot | null;
  onChange(listener: (snapshot: IMUnreadSnapshot | null) => void): () => void;
}): void {
  const targets = new Map<number, IpcMainInvokeEvent>();
  const observed = new WeakSet<IpcMainInvokeEvent["sender"]>();
  options.ipc.handle(IM_IPC_CHANNELS.UNREAD_SNAPSHOT, event => {
    if (!options.isAllowed(event)) return null;
    const id = event.sender.id;
    if (!observed.has(event.sender)) {
      observed.add(event.sender);
      event.sender.once("destroyed", () => targets.delete(id));
    }
    targets.set(id, event);
    return options.getSnapshot();
  });
  options.onChange(snapshot => {
    for (const [id, event] of targets) {
      // 调用时通过检查不足以保证推送时仍在同一文档/账号/域名。
      if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !options.isAllowed(event)) {
        targets.delete(id);
        continue;
      }
      try { event.sender.send(IM_IPC_CHANNELS.UNREAD_CHANGED, snapshot); }
      catch { targets.delete(id); }
    }
  });
}
