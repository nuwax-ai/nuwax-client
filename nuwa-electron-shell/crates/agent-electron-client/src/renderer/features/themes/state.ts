import { useSyncExternalStore } from "react";
import type {
  HostThemesBridge,
  HostThemesState,
} from "@shared/types/hostBridge";

/** Subscribe first so a slow initial read cannot overwrite a newer notification. */
export function observeThemes(
  bridge: HostThemesBridge | undefined,
  changed: (state: HostThemesState | null) => void
) {
  let disposed = false;
  let revision = -1;
  const accept = (state: HostThemesState | null) => {
    if (disposed || (state === null && revision >= 0)) return;
    if (state) {
      if (!Number.isSafeInteger(state.revision) || state.revision <= revision)
        return;
      revision = state.revision;
    }
    changed(state);
  };
  const unsubscribe = bridge?.onChanged(accept);
  if (bridge)
    void bridge
      .getState()
      .then(accept)
      .catch(() => accept(null));
  else accept(null);
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
export function getThemesBridge(): HostThemesBridge | undefined {
  return (
    window.electronAPI as unknown as { themes?: HostThemesBridge } | undefined
  )?.themes;
}
export function createDesktopThemesStore(bridge: HostThemesBridge | undefined) {
  let state: HostThemesState | null = null;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop)
        stop = observeThemes(bridge, (next) => {
          state = next;
          for (const notify of listeners) notify();
        });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
          state = null;
        }
      };
    },
  };
}
const stores = new WeakMap<
  HostThemesBridge,
  ReturnType<typeof createDesktopThemesStore>
>();
const legacyStore = createDesktopThemesStore(undefined);
const emptySnapshot = () => null;
export function useDesktopThemes() {
  const bridge = getThemesBridge();
  let store = bridge ? stores.get(bridge) : legacyStore;
  if (!store) {
    store = createDesktopThemesStore(bridge);
    stores.set(bridge!, store);
  }
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    emptySnapshot
  );
}
