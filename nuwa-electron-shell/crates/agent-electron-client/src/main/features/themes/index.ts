import * as fs from "node:fs/promises";
import { dialog, nativeTheme, shell } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopFeature, FeatureContext } from "../_kit/types";
import { themeChannel, THEMES_CHANGED } from "@shared/features/themes/contract";
import type {
  HostThemeFiles,
  HostThemePreference,
} from "@shared/features/themes/contract";
import { ThemeService, watchThemeDirectory, themeError } from "./service";
export { themeAuthoringContext } from "./service";

let desktopSnapshot:
  | import("@shared/types/hostBridge").HostThemeSnapshot
  | null = null;
const snapshotListeners = new Set<() => void>();
let currentService: ThemeService | null = null;
export const getThemeService = () => currentService;
export const getDesktopThemeSnapshot = () => desktopSnapshot;
export function subscribeDesktopThemeSnapshot(listener: () => void) {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}
function publishDesktopSnapshot(snapshot: typeof desktopSnapshot) {
  desktopSnapshot = snapshot;
  for (const listener of snapshotListeners) {
    try {
      listener();
    } catch {
      /* closing chrome */
    }
  }
}

export class ThemesRuntime {
  readonly service: ThemeService;
  private subscribers = new Map<WebContents, () => void>();
  private disposed = false;
  private systemUpdate = () => {
    void this.service
      .systemChanged()
      .catch((error) =>
        this.ctx.log.warn("[Themes] system update failed", error)
      );
  };
  constructor(private ctx: FeatureContext) {
    this.service = new ThemeService(ctx.dataDir, {
      fs,
      safeMode: process.argv.includes("--safe-theme"),
      watch: watchThemeDirectory,
      systemDark: () => nativeTheme?.shouldUseDarkColors === true,
      applyPreference: (mode) => {
        if (!ctx.settings.write("theme_mode", mode))
          ctx.log.warn("[Themes] legacy theme preference was not saved");
        if (nativeTheme && nativeTheme.themeSource !== mode)
          nativeTheme.themeSource = mode;
      },
      changed: (revision) => {
        if (this.service && !this.disposed)
          publishDesktopSnapshot(this.service.state().snapshot);
        const main = ctx.windows?.getMain()?.webContents;
        if (main && !main.isDestroyed() && !this.subscribers.has(main)) {
          try {
            main.send(THEMES_CHANGED, revision);
          } catch {
            /* host may be closing */
          }
        }
        for (const [contents, cleanup] of this.subscribers) {
          if (contents.isDestroyed()) {
            cleanup();
            continue;
          }
          try {
            contents.send(THEMES_CHANGED, revision);
          } catch {
            cleanup();
          }
        }
      },
    });
    currentService = this.service;
    void this.service.ready
      .then(() => {
        if (!this.disposed)
          publishDesktopSnapshot(this.service.state().snapshot);
      })
      .catch(() => {});
    nativeTheme?.on("updated", this.systemUpdate);
    for (const host of [false, true]) this.register(host);
  }
  private remember(event: IpcMainInvokeEvent) {
    const contents = event.sender;
    if (contents.isDestroyed() || this.subscribers.has(contents)) return;
    const cleanup = () => {
      contents.removeListener("destroyed", cleanup);
      this.subscribers.delete(contents);
    };
    contents.once("destroyed", cleanup);
    this.subscribers.set(contents, cleanup);
  }
  private text(key: string, fallback: string) {
    return this.ctx.translate?.(key) ?? fallback;
  }
  private async confirm() {
    const result = await dialog.showMessageBox({
      type: "question",
      title: this.text("Claw.Themes.dialogReplaceTitle", "Replace theme?"),
      message: this.text(
        "Claw.Themes.dialogReplaceMessage",
        "A theme with this ID already exists. Replace it?"
      ),
      buttons: [
        this.text("Claw.Themes.cancel", "Cancel"),
        this.text("Claw.Themes.dialogReplace", "Replace"),
      ],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  }
  private register(host: boolean) {
    const ipc = host ? this.ctx.hostIpc : this.ctx.ipc;
    const handle = (
      method: string,
      run: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
      denied: unknown = { ok: false, error: "Untrusted theme caller" }
    ) => {
      ipc.handle(
        themeChannel(method, host),
        async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
          if (this.disposed) return denied;
          try {
            await this.service.ready;
            return await run(event, ...args);
          } catch (error) {
            return method === "getState"
              ? this.service.state()
              : { ok: false, error: themeError(error) };
          }
        },
        denied
      );
    };
    handle(
      "getState",
      (event) => {
        this.remember(event);
        return this.service.state();
      },
      null
    );
    handle(
      "unsubscribe",
      (event) => {
        this.subscribers.get(event.sender)?.();
        return undefined;
      },
      undefined
    );
    handle("install", (_event, files: HostThemeFiles, replace?: boolean) =>
      this.service.install(files, replace === true)
    );
    handle("linkDirectory", async () => {
      const picked = await dialog.showOpenDialog({
        title: this.text("Claw.Themes.dialogLinkTitle", "Link theme directory"),
        properties: ["openDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0])
        return { ok: false, canceled: true };
      return this.service.link(picked.filePaths[0], () => this.confirm());
    });
    handle("exportPackage", async (_event, id: string) => ({
      files: await this.service.exportPackage(id),
    }));
    handle(
      "select",
      (
        _event,
        id: string,
        mode: HostThemePreference,
        onlyIfUnselected?: boolean
      ) => this.service.select(id, mode, onlyIfUnselected === true)
    );
    handle("remove", (_event, id: string) => this.service.remove(id));
    handle("openDirectory", async (_event, id: string) => {
      if (await shell.openPath(await this.service.openDirectory(id)))
        throw new Error("Could not open theme directory");
      return { ok: true, state: this.service.state() };
    });
  }
  async dispose() {
    this.disposed = true;
    if (currentService === this.service) currentService = null;
    publishDesktopSnapshot(null);
    nativeTheme?.removeListener("updated", this.systemUpdate);
    for (const cleanup of [...this.subscribers.values()]) cleanup();
    this.ctx.ipc.dispose();
    this.ctx.hostIpc.dispose();
    await this.service.dispose();
  }
}
export const themesFeature: DesktopFeature = {
  id: "themes",
  products: ["nuwax"],
  enabledByDefault: true,
  bridge: { namespaces: ["themes"] },
  register: (ctx) => new ThemesRuntime(ctx),
};
