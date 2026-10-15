import type { App } from "electron";
import path from "node:path";

type IdentityApp = Pick<App, "setName" | "setPath" | "getPath" | "setAppUserModelId">;

export function configureCommercialAppIdentity(
  app: IdentityApp,
  displayName: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // macOS uses this name in its native menu. Windows updater uninstall lookup
  // and Linux WM_CLASS depend on their existing ASCII runtime identity.
  app.setName(platform === "darwin" ? displayName : "Nuwax");
  if (platform === "win32") app.setAppUserModelId("com.nuwax-ai.nuwax");
  app.setPath("userData", path.join(app.getPath("appData"), "Nuwax"));
}
