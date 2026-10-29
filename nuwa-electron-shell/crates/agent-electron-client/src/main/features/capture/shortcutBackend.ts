import { globalShortcut } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import log from 'electron-log';
import { parseCaptureShortcut } from '@shared/features/capture/preferences';

export interface CaptureShortcutBackend {
  isRegistered(shortcut: string): boolean;
  register(shortcut: string, callback: () => void): boolean;
  unregister(shortcut: string): void;
}
interface NativeShortcuts {
  apiVersion: number;
  register(keyCode: number, modifiers: number, callback: () => void): { id: number; status: number };
  unregister(id: number): number;
}

// The preference editor saves KeyboardEvent.code, so keep physical ANSI positions.
const macKeyCodes: Readonly<Record<string, number>> = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11,
  Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, '1': 18, '2': 19, '3': 20,
  '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29,
  O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111, F13: 105, F14: 107, F15: 113,
  F16: 106, F17: 64, F18: 79, F19: 80, F20: 90,
};
const loadNative = createRequire(__filename);
let native: NativeShortcuts | undefined;
let macBackend: CaptureShortcutBackend | undefined;

function nativeShortcuts(): NativeShortcuts {
  if (!native) {
    const loaded = loadNative(path.join(__dirname, 'mac-capture-shortcuts.node')) as NativeShortcuts;
    if (loaded.apiVersion !== 1 || typeof loaded.register !== 'function' || typeof loaded.unregister !== 'function')
      throw new Error('Incompatible macOS capture shortcut addon');
    native = loaded;
  }
  return native;
}

function createMacBackend(): CaptureShortcutBackend {
  const registrations = new Map<string, { id: number; active: boolean }>();
  const canonical = (shortcut: string) => parseCaptureShortcut(shortcut);
  return {
    isRegistered(shortcut) {
      const key = canonical(shortcut);
      return !!key && (registrations.has(key) || globalShortcut.isRegistered(key));
    },
    register(shortcut, callback) {
      const key = canonical(shortcut);
      if (!key || registrations.has(key) || globalShortcut.isRegistered(key)) return false;
      const parts = key.split('+');
      const keyCode = macKeyCodes[parts.pop()!];
      if (keyCode === undefined) return false;
      const modifiers = (parts.includes('CmdOrCtrl') ? 1 << 8 : 0)
        | (parts.includes('Shift') ? 1 << 9 : 0) | (parts.includes('Alt') ? 1 << 11 : 0);
      const entry = { id: 0, active: true };
      try {
        const result = nativeShortcuts().register(keyCode, modifiers, () => {
          if (entry.active && registrations.get(key) === entry) callback();
        });
        if (result.status !== 0 || !Number.isInteger(result.id) || result.id <= 0) {
          log.warn('[CaptureShortcuts] macOS exclusive registration rejected', { shortcut: key, status: result.status });
          return false;
        }
        entry.id = result.id;
        registrations.set(key, entry);
        return true;
      } catch (error) {
        // A normal Electron retry would silently abandon the requested exclusive mode.
        log.warn('[CaptureShortcuts] macOS exclusive registration unavailable', error);
        return false;
      }
    },
    unregister(shortcut) {
      const key = canonical(shortcut);
      const entry = key && registrations.get(key);
      if (!key || !entry) return;
      entry.active = false;
      registrations.delete(key);
      try {
        const status = nativeShortcuts().unregister(entry.id);
        if (status !== 0) log.warn('[CaptureShortcuts] macOS hotkey release failed', { shortcut: key, status });
      } catch (error) { log.warn('[CaptureShortcuts] macOS hotkey release failed', error); }
    },
  };
}

/** Only capture opts into native macOS exclusivity; other features keep Electron. */
export function captureShortcutBackend(platform: NodeJS.Platform): CaptureShortcutBackend {
  return platform === 'darwin' ? macBackend ??= createMacBackend() : globalShortcut;
}
