import { EventEmitter } from 'node:events';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import type { CaptureMenuAction } from '@shared/features/capture/contract';
import { captureShortcutBackend } from './shortcutBackend';

const ownedShortcuts = new Set<string>();
interface CaptureShortcutOwner {
  isActive(): boolean;
  save(shortcut: string, action: CaptureMenuAction, persist: () => void): boolean;
}
let shortcutOwner: CaptureShortcutOwner | undefined;

function reserveShortcut(shortcut: string, platform: NodeJS.Platform): (() => void) | null {
  // A Wayland portal bind may prompt and persist, so it is not an availability probe.
  if (platform !== 'darwin' && platform !== 'win32') return () => {};
  try {
    if (!app.isReady()) return null;
    const backend = captureShortcutBackend(platform);
    if (backend.isRegistered(shortcut)) return ownedShortcuts.has(shortcut) ? () => {} : null;
    if (!backend.register(shortcut, () => {})) return null;
    return () => backend.unregister(shortcut);
  } catch {
    return null;
  }
}

/** Reserve using the same platform backend as the live binding before saving. */
export function saveCaptureShortcutPreference(shortcut: string, action: CaptureMenuAction, persist: () => void, platform: NodeJS.Platform = process.platform): boolean {
  if (shortcutOwner?.isActive()) return shortcutOwner.save(shortcut, action, persist);
  const release = reserveShortcut(shortcut, platform);
  if (!release) return false;
  try {
    persist();
    return true;
  } finally { release(); }
}

const changes = new EventEmitter();
export function notifyCapturePreferencesChanged(): void { changes.emit('changed'); }
export function onCapturePreferencesChanged(listener: () => void): () => void {
  changes.on('changed', listener);
  return () => { changes.removeListener('changed', listener); };
}

/** Own global hotkeys for the app lifetime, including hidden and unfocused windows. */
export function bindCaptureShortcuts(
  target: Pick<BrowserWindow, 'on' | 'removeListener' | 'isDestroyed'>,
  bindings: () => ReadonlyArray<readonly [string, CaptureMenuAction]>,
  dispatch: (action: CaptureMenuAction) => void,
  options: { platform?: NodeJS.Platform; onUnavailable?: (shortcut: string) => void } = {},
): () => void {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') return () => {};
  const backend = captureShortcutBackend(platform);
  const owned = new Map<string, { action: CaptureMenuAction; active: boolean }>();
  let disposed = false;
  const isActive = () => !disposed && !target.isDestroyed() && app.isReady();
  const remove = (shortcut: string) => {
    const entry = owned.get(shortcut);
    if (!entry) return;
    entry.active = false;
    owned.delete(shortcut);
    ownedShortcuts.delete(shortcut);
    backend.unregister(shortcut);
  };
  const release = () => {
    for (const shortcut of owned.keys()) remove(shortcut);
    if (shortcutOwner === owner) shortcutOwner = undefined;
  };
  const acquire = (shortcut: string, action: CaptureMenuAction) => {
    if (backend.isRegistered(shortcut)) return null;
    const entry = { action, active: false };
    try {
      if (backend.register(shortcut, () => {
        if (entry.active && isActive()) dispatch(entry.action);
      })) {
        owned.set(shortcut, entry);
        ownedShortcuts.add(shortcut);
        return entry;
      }
    } catch { /* Preserve the native menu route when the OS refuses registration. */ }
    return null;
  };
  const owner: CaptureShortcutOwner = {
    isActive,
    save(shortcut, action, persist) {
      const existing = owned.get(shortcut);
      if (existing) {
        if (existing.action !== action) return false;
        persist();
        return true;
      }
      const entry = acquire(shortcut, action);
      if (!entry) return false;
      try {
        persist();
        entry.active = true;
        return true;
      } catch (error) {
        remove(shortcut);
        throw error;
      }
    },
  };
  const refresh = () => {
    if (!isActive()) { release(); return; }
    shortcutOwner = owner;
    const desired = new Map(bindings());
    for (const [shortcut, entry] of owned) {
      if (desired.get(shortcut) !== entry.action) remove(shortcut);
    }
    for (const [shortcut, action] of desired) {
      const entry = owned.get(shortcut) ?? acquire(shortcut, action);
      if (entry) entry.active = true;
      else options.onUnavailable?.(shortcut);
    }
  };
  const offPreferences = onCapturePreferencesChanged(refresh);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    release();
    offPreferences();
    target.removeListener('closed', dispose);
    app.removeListener('will-quit', dispose);
  };
  app.on('will-quit', dispose);
  target.on('closed', dispose);
  refresh();
  return dispose;
}
