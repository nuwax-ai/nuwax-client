import type { App } from "electron";
import path from "node:path";

type IdentityApp = Pick<App, "setName" | "setPath" | "getPath">;

export function configureCommercialAppIdentity(
  app: IdentityApp,
  displayName: string,
  platform: NodeJS.Platform = process.platform,
  profileName = "Nuwax",
): void {
  // macOS uses this name in its native menu. Windows updater uninstall lookup
  // and Linux WM_CLASS depend on their existing ASCII runtime identity.
  app.setName(platform === "darwin" ? displayName : profileName);
  app.setPath("userData", path.join(app.getPath("appData"), profileName));
}
