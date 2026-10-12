/**
 * 桌面特性静态注册表 + 运行时：特性接入客户端的唯一汇合点（公开入口）。
 *
 * 新增一个特性 = 在 `features/<id>/` 写一个 `DesktopFeature`，并在 `desktopFeatures` 加一行。
 * 不做动态加载；加载与否由 `products` 与开关决定（见 `_kit/register.ts`）。
 *
 * 客户端其余代码只通过这里使用特性：
 *   - `startDesktopFeatures`：在 IPC 注册阶段调用一次；
 *   - `notifyFeatureSessionEnd`：登出/换域时调用；
 *   - `disposeDesktopFeatures`：应用退出时调用。
 * 本文件不 import electron / 数据库，所有宿主能力由调用方注入，便于单测。
 */

import * as nodePath from "node:path";
import { createFeatureLifecycle, type FeatureLifecycle, type SessionEndReason } from "./_kit/lifecycle";
import { registerDesktopFeatures, type RegisteredFeatures } from "./_kit/register";
import { createScratchDir } from "./_kit/scratchDir";
import { createTrustedIpc, type IpcMainLike } from "./_kit/trustedIpc";
import type { DesktopFeature, FeatureContext, FeatureLogger } from "./_kit/types";
import { captureFeature } from "./capture";
import { openSourceNoticesFeature } from "./open-source-notices";

export type { SessionEndReason };

export const desktopFeatures: readonly DesktopFeature[] = [
  captureFeature,
  openSourceNoticesFeature,
];

export interface StartFeaturesOptions {
  product: string;
  ipcMain: IpcMainLike;
  /** 业务页调用方是否受信（受信顶层文档且为当前代次）。 */
  isBusinessSender(event: never): boolean;
  /** 宿主壳渲染进程调用方是否受信。 */
  isHostSender(event: never): boolean;
  /** 客户端数据目录（`~/.nuwax`）；各特性的临时目录建在其下。 */
  dataDir: string;
  /** 运行期开关：设置项覆盖 ?? 清单默认值。 */
  isEnabled(featureId: string, enabledByDefault: boolean): boolean;
  log: FeatureLogger;
  translate?(key: string): string;
  setRecordingStopAction?(action: (() => void) | null): void;
}

let lifecycle: FeatureLifecycle | null = null;
let registered: RegisteredFeatures | null = null;

/** 原生宿主入口读取实际注册结果，关闭或注册失败时不显示入口。 */
export function isDesktopFeatureRegistered(id: string): boolean {
  return registered?.ids.includes(id) === true;
}

export function startDesktopFeatures(
  options: StartFeaturesOptions,
  features: readonly DesktopFeature[] = desktopFeatures,
): RegisteredFeatures {
  if (registered) return registered;
  const lc = createFeatureLifecycle((error) =>
    options.log.error("[Features] lifecycle listener failed", error),
  );
  lifecycle = lc;

  const createContext = (feature: DesktopFeature): FeatureContext => ({
    product: options.product,
    ipc: createTrustedIpc(options.ipcMain, options.isBusinessSender),
    hostIpc: createTrustedIpc(options.ipcMain, options.isHostSender),
    lifecycle: lc,
    scratch: createScratchDir(nodePath.join(options.dataDir, feature.id)),
    log: options.log,
    translate: options.translate,
    setRecordingStopAction: options.setRecordingStopAction,
  });

  registered = registerDesktopFeatures(features, {
    product: options.product,
    isEnabled: options.isEnabled,
    createContext,
    log: options.log,
  });
  return registered;
}

/** 登出 / 换域：通知各特性取消进行中的工作并清理。 */
export function notifyFeatureSessionEnd(reason: SessionEndReason): void {
  lifecycle?.emitSessionEnd(reason);
}

/** 应用退出：先通知退出，再释放全部特性。 */
export async function disposeDesktopFeatures(): Promise<void> {
  const lc = lifecycle;
  const reg = registered;
  lifecycle = null;
  registered = null;
  if (lc) await lc.emitQuit();
  if (reg) await reg.dispose();
}
