import { app, BrowserWindow, desktopCapturer, dialog, shell } from 'electron';
import path from 'node:path';

const SCREEN_CAPTURE_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export interface ScreenPermissionPromptLabels {
  title: string;
  /** `{0}` is replaced with the name System Settings lists for this app. */
  detail: string;
  openSettings: string;
  cancel: string;
}

/** System Settings lists the running bundle: Nuwax when installed, Electron in development. */
function listedAppName(): string {
  try { return path.basename(app.getPath('exe')) || app.getName(); }
  catch { return app.getName(); }
}

/**
 * macOS stops asking once screen recording was refused, and only lists an app in
 * System Settings after it has requested capture, so request once, then explain and
 * offer the exact settings pane. Concurrent triggers share one dialog.
 */
export function createScreenPermissionPrompt(options: {
  labels: () => ScreenPermissionPromptLabels;
  log: { warn(...args: unknown[]): void };
}): () => Promise<void> {
  let showing: Promise<void> | null = null;
  const run = async () => {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch((error) => options.log.warn('[Capture] screen permission request failed', error));
    const labels = options.labels();
    const box: Electron.MessageBoxOptions = {
      type: 'warning', title: labels.title, message: labels.title,
      detail: labels.detail.replace('{0}', listedAppName()),
      buttons: [labels.openSettings, labels.cancel], defaultId: 0, cancelId: 1, noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible());
    const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
    if (response === 0) await shell.openExternal(SCREEN_CAPTURE_PANE).catch((error) => options.log.warn('[Capture] could not open screen recording settings', error));
  };
  return () => {
    showing ??= run().catch((error) => options.log.warn('[Capture] screen permission prompt failed', error)).finally(() => { showing = null; });
    return showing;
  };
}
