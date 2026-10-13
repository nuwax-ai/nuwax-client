import type { CustomScheme, OnBeforeRequestListenerDetails } from "electron";
import * as nodePath from "node:path";
import { createFeatureLifecycle, type FeatureLifecycle, type SessionEndReason } from "./_kit/lifecycle";
import { registerDesktopFeatures, type RegisteredFeatures } from "./_kit/register";
import { createScratchDir } from "./_kit/scratchDir";
import { createTrustedIpc, type IpcMainLike } from "./_kit/trustedIpc";
import type { DesktopFeature, FeatureContext, FeatureLogger, FeatureWorkspaceServices } from "./_kit/types";
import { authorizeLocalFilesRequest, isLocalFilesRequestSource, localFilesFeature } from "./local-files";

export const desktopFeatures: readonly DesktopFeature[] = [localFilesFeature];
export interface StartFeaturesOptions {
  product: string;
  ipcMain: IpcMainLike;
  isBusinessSender(event: never): boolean;
  isHostSender(event: never): boolean;
  dataDir: string;
  isEnabled(featureId: string, enabledByDefault: boolean): boolean;
  log: FeatureLogger;
  translate?(key: string): string;
  workspace?: FeatureWorkspaceServices;
}
let lifecycle: FeatureLifecycle | null = null;
let registered: RegisteredFeatures | null = null;

/** Electron requires a single declaration before app.ready; handlers remain gated. */
export function desktopFeatureSchemes(product: string): CustomScheme[] {
  return desktopFeatures.filter(feature => feature.products.includes(product))
    .flatMap(feature => [...(feature.schemes ?? [])]);
}

export function startDesktopFeatures(options: StartFeaturesOptions): RegisteredFeatures {
  if (registered) return registered;
  const lc = createFeatureLifecycle(error => options.log.error("[Features] lifecycle failed", error));
  lifecycle = lc;
  registered = registerDesktopFeatures(desktopFeatures, {
    product: options.product, isEnabled: options.isEnabled, log: options.log,
    createContext: (feature): FeatureContext => ({
      product: options.product,
      ipc: createTrustedIpc(options.ipcMain, options.isBusinessSender),
      hostIpc: createTrustedIpc(options.ipcMain, options.isHostSender),
      lifecycle: lc, scratch: createScratchDir(nodePath.join(options.dataDir, feature.id)),
      log: options.log, translate: options.translate, workspace: options.workspace,
    }),
  });
  return registered;
}
export function notifyFeatureSessionEnd(reason: SessionEndReason = "other"): void {
  lifecycle?.emitSessionEnd(reason);
}
export function isDesktopFeatureEnabled(id: string): boolean {
  return registered?.ids.includes(id) ?? false;
}
export async function disposeDesktopFeatures(): Promise<void> {
  const lc = lifecycle; const reg = registered;
  lifecycle = null; registered = null;
  await lc?.emitQuit();
  await reg?.dispose();
}
/** Invoked by the existing single Session request listener, never installs another. */
export function authorizeDesktopFeatureRequest(details: OnBeforeRequestListenerDetails): boolean | undefined {
  return authorizeLocalFilesRequest(details);
}

/** Share preview provenance with the existing credential-filtering listener. */
export const isDesktopFeatureRequestSource = isLocalFilesRequestSource;
