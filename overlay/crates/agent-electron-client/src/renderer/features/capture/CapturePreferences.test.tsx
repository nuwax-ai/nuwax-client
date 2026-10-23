import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Input, Switch, Button } from 'antd';
import { CAPTURE_HIDE_WINDOW_SETTING, CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING } from '@shared/features/capture/preferences';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)>, error: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(value: unknown) {
    const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = value;
    return [hooks.values[i], (next: unknown) => { hooks.values[i] = next; }];
  },
  useEffect(effect: () => void | (() => void)) { hooks.effects.push(effect); },
}));
vi.mock('antd', () => ({ Input: vi.fn(), Switch: vi.fn(), Button: vi.fn(), Space: vi.fn(), message: { error: hooks.error } }));
import { CapturePreferences } from './CapturePreferences';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => { hooks.values.length = 0; hooks.effects.length = 0; hooks.cursor = 0; vi.clearAllMocks(); });
function mount(platform: string) {
  vi.stubGlobal('navigator', { platform });
  const settings = { get: vi.fn(async () => null), set: vi.fn(async () => true) };
  const onShortcutChange = vi.fn(), onRecordShortcutChange = vi.fn();
  const paint = () => {
    hooks.cursor = 0;
    const tree = CapturePreferences({ settings, t: key => key, onShortcutChange, onRecordShortcutChange });
    const found: React.ReactElement[] = [];
    const walk = (value: React.ReactNode) => React.Children.forEach(value, child => {
      if (!React.isValidElement(child)) return;
      found.push(child); walk((child.props as { children?: React.ReactNode }).children);
    });
    walk(tree);
    return { inputs: found.filter(child => child.type === Input).map(child => child.props),
      toggle: found.find(child => child.type === Switch)!.props,
      saves: found.filter(child => child.type === Button && child.props.children === 'Claw.Capture.shortcutSave').map(child => child.props) };
  };
  paint(); hooks.effects.forEach(effect => effect());
  return { settings, paint, onShortcutChange, onRecordShortcutChange };
}

it.each(['MacIntel', 'Win32', 'Linux x86_64'])('%s shows the platform modifier and keeps successful edits in sync with menus', async platform => {
  const f = mount(platform); await flush();
  const mac = platform === 'MacIntel';
  expect(f.paint().toggle.checked).toBe(false);
  expect(f.paint().inputs.map(input => input.value)).toEqual([`${mac ? 'Command' : 'Ctrl'}+Shift+A`, `${mac ? 'Command' : 'Ctrl'}+Shift+R`]);
  const event = { key: 'g', code: 'KeyG', ctrlKey: !mac, metaKey: mac, shiftKey: true, altKey: false, preventDefault: vi.fn() };
  f.paint().inputs[0].onKeyDown(event); f.paint().saves[0].onClick(); await flush();
  expect(f.settings.set).toHaveBeenCalledWith(CAPTURE_SHORTCUT_SETTING, 'CmdOrCtrl+Shift+G');
  expect(f.onShortcutChange).toHaveBeenLastCalledWith('CmdOrCtrl+Shift+G');
  f.paint().inputs[1].onKeyDown({ ...event, key: 'h', code: 'KeyH' }); f.paint().saves[1].onClick(); await flush();
  expect(f.settings.set).toHaveBeenCalledWith(CAPTURE_RECORD_SHORTCUT_SETTING, 'CmdOrCtrl+Shift+H');
  expect(f.onRecordShortcutChange).toHaveBeenLastCalledWith('CmdOrCtrl+Shift+H');
});

it('a failed preference write keeps the saved toggle and menu shortcuts', async () => {
  const f = mount('Win32'); await flush();
  f.settings.set.mockResolvedValue(false);
  f.paint().toggle.onChange(true); await flush();
  expect(f.settings.set).toHaveBeenCalledWith(CAPTURE_HIDE_WINDOW_SETTING, true);
  expect(f.paint().toggle.checked).toBe(false);
  expect(hooks.error).toHaveBeenCalledWith('Claw.Capture.preferenceSaveFailed');
});
