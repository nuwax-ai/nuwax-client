import type { IpcRenderer } from "electron";
import type {
  HostThemesBridge,
  HostThemesState,
} from "@shared/features/themes/contract";
import { THEMES_CHANGED, themeChannel } from "@shared/features/themes/contract";

export function createThemesBridge(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
  host = false
): HostThemesBridge {
  const listeners = new Set<(state: HostThemesState) => void>();
  let generation = 0,
    request = 0,
    latestRevision = 0;
  const read = async () => {
    const current = generation,
      ticket = ++request;
    try {
      const state = (await ipc.invoke(
        themeChannel("getState", host)
      )) as HostThemesState | null;
      if (
        current !== generation ||
        ticket !== request ||
        !state ||
        state.revision < latestRevision
      )
        return;
      latestRevision = state.revision;
      for (const listener of [...listeners]) {
        try {
          listener(state);
        } catch {
          /* isolate listeners */
        }
      }
    } catch {
      /* navigated/revoked documents cannot read state */
    }
  };
  const changed = (_event: unknown, revision: unknown) => {
    if (
      !Number.isSafeInteger(revision) ||
      (revision as number) < latestRevision
    )
      return;
    latestRevision = revision as number;
    void read();
  };
  return {
    async getState() {
      const current = generation;
      try {
        const state = (await ipc.invoke(
          themeChannel("getState", host)
        )) as HostThemesState | null;
        if (current !== generation || !state || state.revision < latestRevision)
          return null;
        latestRevision = state.revision;
        return state;
      } catch {
        return null;
      }
    },
    install: (files, replace) =>
      ipc.invoke(themeChannel("install", host), files, replace),
    linkDirectory: () => ipc.invoke(themeChannel("linkDirectory", host)),
    exportPackage: (id) => ipc.invoke(themeChannel("exportPackage", host), id),
    select: (id, mode, onlyIfUnselected) =>
      ipc.invoke(themeChannel("select", host), id, mode, onlyIfUnselected),
    remove: (id) => ipc.invoke(themeChannel("remove", host), id),
    openDirectory: (id) => ipc.invoke(themeChannel("openDirectory", host), id),
    onChanged(listener) {
      if (!listeners.size) {
        generation++;
        ipc.on(THEMES_CHANGED, changed);
      }
      listeners.add(listener);
      void read();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          generation++;
          request++;
          ipc.removeListener(THEMES_CHANGED, changed);
          void ipc
            .invoke(themeChannel("unsubscribe", host))
            .catch(() => undefined);
        }
      };
    },
  };
}
export async function themesCapabilityProbe(
  _capability: unknown,
  name: string,
  bridge: { themes?: HostThemesBridge },
  authorize: (name: string) => Promise<boolean>
): Promise<boolean> {
  return (
    !!(await bridge.themes?.getState()) && (await authorize(name)) === true
  );
}
