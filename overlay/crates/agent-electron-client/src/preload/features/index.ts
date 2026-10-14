/**
 * preload 侧的特性命名空间汇总：与主进程 `features/index.ts` 的注册表一一对应，是 preload
 * 引用特性的唯一公开入口。
 *
 * - `featureNamespaces`：给受信顶层业务页（`NuwaClawBridge.*`），门控在调用处，同 `im`；
 * - `hostFeatureNamespaces`：给宿主壳渲染进程（`window.electronAPI.*`）。
 */

import type { IpcRenderer } from "electron";
import { HOST_CAPTURE_IPC, HOST_CAPTURE_SAVE_IPC, HOST_CAPTURE_MENU_IPC, type CaptureBridge, type HostCaptureBridge, type CaptureMenuAction } from "@shared/features/capture/contract";
import type { NoticesBridge } from "@shared/features/open-source-notices/contract";
import { createCaptureBridge } from "./capture";
import { createNoticesBridge } from "./open-source-notices";
import { createLocalFilesBridge } from "./local-files";

export interface FeatureNamespaces {
  capture: CaptureBridge;
  localFiles: ReturnType<typeof createLocalFilesBridge>;
}

export interface HostFeatureNamespaces {
  notices: NoticesBridge;
  capture: HostCaptureBridge;
}

export function featureNamespaces(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): FeatureNamespaces {
  return { capture: createCaptureBridge(ipc), localFiles: createLocalFilesBridge(ipc) };
}

export function hostFeatureNamespaces(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): HostFeatureNamespaces {
  return {
    notices: createNoticesBridge(ipc),
    capture: {
      ...createCaptureBridge(ipc, HOST_CAPTURE_IPC),
      save: (resultId) => ipc.invoke(HOST_CAPTURE_SAVE_IPC, resultId),
      onMenuAction: (listener) => {
        const handler = (_event: unknown, action: unknown) => {
          if (typeof action === "string" && ["screenshot", "mp4", "webm", "gif"].includes(action)) {
            listener(action as CaptureMenuAction);
          }
        };
        ipc.on(HOST_CAPTURE_MENU_IPC, handler);
        return () => ipc.removeListener(HOST_CAPTURE_MENU_IPC, handler);
      },
    },
  };
}
