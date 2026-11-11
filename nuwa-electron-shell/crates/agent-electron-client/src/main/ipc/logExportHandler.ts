import { app, dialog, ipcMain } from "electron";
import type { HandlerContext } from "@shared/types/ipc";
import type { LogExportResult } from "@shared/types/electron";
import {
  APP_NAME_IDENTIFIER,
  I18N_KEYS,
  LOGS_DIR_NAME,
} from "@shared/constants";
import path from "node:path";
import log from "electron-log";
import { getAppDataDir } from "../services/system/appPaths";
import { t } from "../services/i18n";
import { exportLogArchive } from "../services/utils/logArchive";
import { isHostRendererSender } from "./bridgeTrust";
import { formatLocalFileTimestamp } from "../features";

export function registerLogExportHandler(ctx: HandlerContext): void {
  let exporting = false;
  ipcMain.handle("log:exportZip", async (event): Promise<LogExportResult> => {
    const host = ctx.getMainWindow();
    if (
      !isHostRendererSender(
        event,
        ctx.getMainWindow()?.webContents,
        app.isPackaged,
      )
    ) {
      return { success: false, error: "Host renderer required" };
    }
    if (exporting)
      return { success: false, error: "Log export already in progress" };
    exporting = true;
    try {
      const timestamp = formatLocalFileTimestamp();
      const saved = await dialog.showSaveDialog(host!, {
        title: t(I18N_KEYS.Pages.LogViewer.EXPORT),
        defaultPath: path.join(
          app.getPath("downloads"),
          `${APP_NAME_IDENTIFIER}-logs-${timestamp}.zip`,
        ),
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (saved.canceled || !saved.filePath)
        return { success: false, canceled: true };
      if (
        !isHostRendererSender(
          event,
          ctx.getMainWindow()?.webContents,
          app.isPackaged,
        )
      ) {
        return { success: false, error: "Host renderer required" };
      }
      const destination = saved.filePath.toLowerCase().endsWith(".zip")
        ? saved.filePath
        : `${saved.filePath}.zip`;
      await exportLogArchive(
        path.join(getAppDataDir(), LOGS_DIR_NAME),
        destination,
      );
      return { success: true, filePath: destination };
    } catch (error) {
      log.error("[IPC] log:exportZip failed:", error);
      return { success: false, error: String(error) };
    } finally {
      exporting = false;
    }
  });
}
