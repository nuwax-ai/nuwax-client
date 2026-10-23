export const CAPTURE_HIDE_WINDOW_SETTING = 'capture.hideAppWindow';
export const CAPTURE_SHORTCUT_SETTING = 'capture.screenshotShortcut';
export const CAPTURE_RECORD_SHORTCUT_SETTING = 'capture.recordShortcut';
export const DEFAULT_RECORD_SHORTCUT = 'CmdOrCtrl+Shift+R';
export const DEFAULT_CAPTURE_SHORTCUT = 'CmdOrCtrl+Shift+A';

/** Portable application accelerator; keep editing/navigation commands available to the guest. */
export function parseCaptureShortcut(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tokens = value.split('+');
  const key = tokens.pop()?.toUpperCase();
  if (!key || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key)) return null;
  if (!tokens.length || new Set(tokens).size !== tokens.length || tokens.some(t => !['CmdOrCtrl', 'Alt', 'Shift'].includes(t))) return null;
  if (!tokens.includes('CmdOrCtrl') && !tokens.includes('Alt')) return null;
  const modifiers = ['CmdOrCtrl', 'Alt', 'Shift'].filter(t => tokens.includes(t));
  const shortcut = [...modifiers, key].join('+');
  if (/^CmdOrCtrl\+(?:[ACFKNQRSTVWXZ]|[0-9])$/.test(shortcut) || /^CmdOrCtrl\+Shift\+(?:[INPZ])$/.test(shortcut) || /^Alt\+F4$/.test(shortcut) || /^CmdOrCtrl\+Alt\+[PR]$/.test(shortcut)) return null;
  return shortcut;
}

export const captureShortcut = (value: unknown): string => parseCaptureShortcut(value) ?? DEFAULT_CAPTURE_SHORTCUT;
export const recordShortcut = (value: unknown): string => parseCaptureShortcut(value) ?? DEFAULT_RECORD_SHORTCUT;
export const displayCaptureShortcut = (value: unknown, mac: boolean): string => captureShortcut(value).replace('CmdOrCtrl', mac ? 'Command' : 'Ctrl');

export function shortcutFromKeyboard(event: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): string | null {
  if (mac ? event.ctrlKey : event.metaKey) return null;
  const key = event.code?.replace(/^(?:Key|Digit)/, '') ?? event.key;
  return parseCaptureShortcut([...(mac ? event.metaKey ? ['CmdOrCtrl'] : [] : event.ctrlKey ? ['CmdOrCtrl'] : []),
    ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key.toUpperCase()].join('+'));
}
