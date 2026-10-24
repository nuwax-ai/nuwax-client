import log from "electron-log";
import { initAutoUpdater as initBaseAutoUpdater } from "./autoUpdater";

/** The commercial update server serves complete packages, without multipart Range. */
export const initAutoUpdater: typeof initBaseAutoUpdater = (...args) => {
  initBaseAutoUpdater(...args);
  // Apply after the base initializer, which otherwise enables the macOS default.
  // Use its same CJS singleton so downloads and install/cleanup callbacks stay together.
  const { autoUpdater } = require("electron-updater");
  autoUpdater.disableDifferentialDownload = true;
  log.info("[AutoUpdater] Commercial update source: full package download only");
};
