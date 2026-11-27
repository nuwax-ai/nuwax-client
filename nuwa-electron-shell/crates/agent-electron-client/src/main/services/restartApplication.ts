import { app } from "electron";
import { IS_DEV_PROFILE } from "@shared/constants";

// The development supervisor owns Electron and restarts it after cleanup.
const DEV_RESTART_EXIT_CODE = 75;
let supervisedRestart = false;

export function restartApplication(): void {
  if (!app.isPackaged && IS_DEV_PROFILE && process.env.NUWAX_DEV_SUPERVISED === "1") {
    supervisedRestart = true;
  } else {
    app.relaunch();
  }
  app.quit();
}

export function applicationExitCode(): number {
  return supervisedRestart ? DEV_RESTART_EXIT_CODE : 0;
}
