import {
  BROWSER_FEATURE_SETTING,
  BROWSER_IPC,
} from "@shared/features/browser/contract";
import type { DesktopFeature } from "../_kit/types";
import {
  createBrowserWindows,
  type BrowserPageOptions,
  type BrowserPage,
} from "./windows";

let active: {
  windows: ReturnType<typeof createBrowserWindows>;
  available(): boolean;
} | null = null;
export const isDesktopBrowserAvailable = (): boolean => {
  try {
    return active?.available() === true;
  } catch {
    return false;
  }
};
export const refreshDesktopBrowserWindows = (): void =>
  active?.windows.refresh();
export function createDesktopBrowserPage(
  options: BrowserPageOptions
): BrowserPage | null {
  return isDesktopBrowserAvailable() ? active!.windows.open(options) : null;
}
export const browserFeature: DesktopFeature = {
  id: "browser",
  products: ["nuwax"],
  enabledByDefault: true,
  bridge: { namespaces: ["browser"] },
  register(ctx) {
    const windows = createBrowserWindows(ctx);
    const instance = {
      windows,
      available: () => ctx.settings.read(BROWSER_FEATURE_SETTING) !== false,
    };
    active = instance;
    const capabilities = () => ({ available: isDesktopBrowserAvailable() });
    try {
      ctx.ipc.handle(BROWSER_IPC.capabilities, capabilities, {
        available: false,
      });
      ctx.hostIpc.handle(BROWSER_IPC.hostCapabilities, capabilities, {
        available: false,
      });
    } catch (error) {
      active = null;
      windows.dispose();
      ctx.ipc.dispose();
      ctx.hostIpc.dispose();
      throw error;
    }
    const offSession = ctx.lifecycle.onSessionEnd(() => windows.closeAll());
    return {
      dispose() {
        if (active === instance) active = null;
        offSession();
        windows.dispose();
        ctx.ipc.dispose();
        ctx.hostIpc.dispose();
      },
    };
  },
};
