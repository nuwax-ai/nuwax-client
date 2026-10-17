import { ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { isPermissionKey } from "@shared/types/permissionOnboarding";
import {
  getPermissionSnapshot,
  markPermissionOnboardingSeen,
  openGuidedPermissionSettings,
  restartForPermissions,
  setPermissionGuideWindowProvider,
  showPermissionApp,
} from "../services/permissionOnboarding";

export function registerPermissionOnboardingHandlers(options: {
  trusted(event: IpcMainInvokeEvent): boolean;
  getWindow(): BrowserWindow | null;
}): void {
  setPermissionGuideWindowProvider(options.getWindow);
  ipcMain.handle("permissions:onboarding:snapshot", (event) =>
    options.trusted(event) ? getPermissionSnapshot() : null,
  );
  ipcMain.handle("permissions:onboarding:seen", (event) =>
    options.trusted(event) ? markPermissionOnboardingSeen() : false,
  );
  ipcMain.handle("permissions:onboarding:settings", (event, key: unknown) =>
    options.trusted(event) && isPermissionKey(key)
      ? openGuidedPermissionSettings(key)
      : false,
  );
  ipcMain.handle("permissions:onboarding:showApp", (event) =>
    options.trusted(event) ? showPermissionApp() : false,
  );
  ipcMain.handle("permissions:onboarding:restart", (event) =>
    options.trusted(event) ? restartForPermissions() : false,
  );
}
