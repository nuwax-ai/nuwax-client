/**
 * preload 侧的「开源组件声明」桥（宿主壳渲染进程的 `window.electronAPI.notices`）。
 * 特性关闭（主进程没注册 IPC）时返回 null，调用方按「暂无数据」处理，不抛错。
 */

import type { IpcRenderer } from "electron";
import {
  NOTICES_IPC,
  type NoticesBridge,
  type NoticesDocument,
} from "@shared/features/open-source-notices/contract";

export function createNoticesBridge(
  ipc: Pick<IpcRenderer, "invoke">,
): NoticesBridge {
  return {
    async get() {
      try {
        return (await ipc.invoke(NOTICES_IPC.GET)) as NoticesDocument | null;
      } catch {
        return null;
      }
    },
    async getLicenseText(id) {
      try {
        return (await ipc.invoke(NOTICES_IPC.GET_LICENSE_TEXT, id)) as string | null;
      } catch {
        return null;
      }
    },
  };
}
