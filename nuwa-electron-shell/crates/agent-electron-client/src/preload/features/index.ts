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
import type { ComputerUseAPI } from "@shared/features/computer-use/contract";
import { createCaptureBridge, captureCapabilityProbe } from "./capture";
import { createNoticesBridge } from "./open-source-notices";
import { createLocalFilesBridge, localFilesCapabilityProbe } from "./local-files";
import { createComputerUseBridge } from "./computer-use";
import { createBrowserBridge } from './browser';

export interface FeatureNamespaces {
  browser: ReturnType<typeof createBrowserBridge>;
  capture: CaptureBridge;
  localFiles: ReturnType<typeof createLocalFilesBridge>;
}

export interface HostFeatureNamespaces {
  browser: ReturnType<typeof createBrowserBridge>;
  notices: NoticesBridge;
  capture: HostCaptureBridge;
  computerUse: ComputerUseAPI;
  features: { registered: () => Promise<string[]> };
}

export function featureNamespaces(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): FeatureNamespaces {
  return { browser: createBrowserBridge(ipc), capture: createCaptureBridge(ipc), localFiles: createLocalFilesBridge(ipc) };
}

export function hostFeatureNamespaces(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): HostFeatureNamespaces {
  return {
    browser: createBrowserBridge(ipc, true),
    notices: createNoticesBridge(ipc),
    computerUse: createComputerUseBridge(ipc),
    features: { registered: () => ipc.invoke("features:registered") as Promise<string[]> },
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

export type CapabilityProbe = (
  capability: { methods: readonly string[]; variant?: string },
  name: string,
  bridge: unknown,
  authorize: (name: string) => Promise<boolean>,
) => Promise<boolean>;

const FEATURE_PROBES: Record<string, CapabilityProbe> = {
  capture: captureCapabilityProbe as CapabilityProbe,
  localFiles: localFilesCapabilityProbe as CapabilityProbe,
};

/**
 * canUse 的特性侧探测：命名空间不归任何特性时返回 null（由 canUse 通用流程判定）；
 * 归属特性的可用性/格式探测在各特性 preload 文件里实现。
 */
export function probeFeatureCapability(
  namespace: string,
  capability: { methods: readonly string[]; variant?: string },
  name: string,
  bridge: unknown,
  authorize: (name: string) => Promise<boolean>,
): Promise<boolean> | null {
  const probe = FEATURE_PROBES[namespace];
  return probe ? probe(capability, name, bridge, authorize) : null;
}
