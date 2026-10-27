import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const runtime = vi.hoisted(() => ({
  ready: vi.fn(), registered: vi.fn(), register: vi.fn(), unregister: vi.fn(),
  on: vi.fn(), removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isReady: runtime.ready, on: runtime.on, removeListener: runtime.removeListener },
  globalShortcut: { isRegistered: runtime.registered, register: runtime.register, unregister: runtime.unregister },
}));
import { bindCaptureShortcuts, notifyCapturePreferencesChanged, saveCaptureShortcutPreference } from './preferences';

const shortcut = 'CmdOrCtrl+Shift+A';
const isCaptureShortcutAvailable = (key: string, platform: NodeJS.Platform) => saveCaptureShortcutPreference(key, 'screenshot', () => {}, platform);
const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); });
beforeEach(() => {
  vi.resetAllMocks();
  runtime.ready.mockReturnValue(true);
  runtime.registered.mockReturnValue(false);
  runtime.register.mockReturnValue(true);
});

describe.each(['darwin', 'win32', 'linux'] as const)('%s global capture shortcuts', platform => {
  function bind() {
    const target = Object.assign(new EventEmitter(), {
      isFocused: vi.fn(() => false), isDestroyed: vi.fn(() => false),
    });
    let screenshot = shortcut;
    const dispatch = vi.fn();
    const unavailable = vi.fn();
    const dispose = bindCaptureShortcuts(target as never,
      () => [[screenshot, 'screenshot'], ['CmdOrCtrl+Shift+R', 'mp4']], dispatch,
      { platform, onUnavailable: unavailable });
    disposers.push(dispose);
    const focus = () => { target.isFocused.mockReturnValue(true); target.emit('focus'); };
    const blur = () => { target.isFocused.mockReturnValue(false); target.emit('blur'); };
    return { target, dispatch, unavailable, dispose, focus, blur, change: (value: string) => { screenshot = value; notifyCapturePreferencesChanged(); } };
  }

  it('registers while unfocused and keeps screenshot/recording active after blur, hiding and minimization', () => {
    const f = bind();
    expect(runtime.register.mock.calls.map(([key]) => key)).toEqual([shortcut, 'CmdOrCtrl+Shift+R']);
    const screenshotCallback = runtime.register.mock.calls[0][1];
    const recordCallback = runtime.register.mock.calls[1][1];
    screenshotCallback(); recordCallback();
    expect(f.dispatch.mock.calls).toEqual([['screenshot'], ['mp4']]);
    f.blur();
    f.target.emit('hide'); f.target.emit('minimize');
    expect(runtime.unregister).not.toHaveBeenCalled();
    screenshotCallback(); recordCallback();
    expect(f.dispatch.mock.calls).toEqual([['screenshot'], ['mp4'], ['screenshot'], ['mp4']]);
    f.dispose();
    expect(runtime.unregister.mock.calls).toEqual([[shortcut], ['CmdOrCtrl+Shift+R']]);
    screenshotCallback(); recordCallback();
    expect(f.dispatch).toHaveBeenCalledTimes(4);
  });

  it('recognizes its active binding when saving the same key and rebinds saved preferences without stale callbacks', () => {
    const f = bind(); f.focus();
    const staleCallback = runtime.register.mock.calls[0][1];
    runtime.registered.mockReturnValue(true);
    expect(isCaptureShortcutAvailable(shortcut, platform)).toBe(true);
    expect(runtime.register).toHaveBeenCalledTimes(2);
    runtime.registered.mockReturnValue(false);
    f.change('CmdOrCtrl+Alt+G');
    expect(runtime.unregister.mock.calls).toEqual([[shortcut]]);
    staleCallback();
    expect(f.dispatch).not.toHaveBeenCalled();
    runtime.register.mock.calls[2][1]();
    expect(f.dispatch).toHaveBeenCalledWith('screenshot');
  });

  it('does not replace or unregister another feature binding and reports registration failure', () => {
    runtime.registered.mockImplementation(key => key === shortcut);
    runtime.register.mockReturnValue(false);
    const f = bind(); f.focus();
    expect(runtime.register).toHaveBeenCalledOnce();
    expect(f.unavailable.mock.calls).toEqual([[shortcut], ['CmdOrCtrl+Shift+R']]);
    f.blur(); f.dispose();
    expect(runtime.unregister).not.toHaveBeenCalled();
  });

  it('cleans listeners and registrations when closed and ignores late callbacks', () => {
    const f = bind(); f.focus();
    const callback = runtime.register.mock.calls[0][1];
    f.target.emit('closed'); f.dispose();
    expect(runtime.unregister).toHaveBeenCalledTimes(2);
    expect(f.target.listenerCount('focus')).toBe(0);
    expect(f.target.listenerCount('blur')).toBe(0);
    expect(f.target.listenerCount('closed')).toBe(0);
    f.change('CmdOrCtrl+Alt+G'); callback();
    expect(runtime.register).toHaveBeenCalledTimes(2);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the old binding when the replacement is rejected or persistence fails', () => {
    const f = bind(); f.focus();
    const original = runtime.register.mock.calls[0][1];
    const persist = vi.fn();
    runtime.register.mockReturnValue(false);
    expect(saveCaptureShortcutPreference('CmdOrCtrl+Alt+G', 'screenshot', persist, platform)).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(runtime.unregister).not.toHaveBeenCalled();
    runtime.register.mockReturnValue(true);
    const error = new Error('database write failed');
    persist.mockImplementation(() => { throw error; });
    expect(() => saveCaptureShortcutPreference('CmdOrCtrl+Alt+G', 'screenshot', persist, platform)).toThrow(error);
    expect(runtime.unregister.mock.calls).toEqual([['CmdOrCtrl+Alt+G']]);
    original();
    expect(f.dispatch).toHaveBeenCalledWith('screenshot');
  });

  it('reserves a replacement before persistence and keeps it through the saved-preferences refresh', () => {
    const f = bind(); f.focus();
    const original = runtime.register.mock.calls[0][1];
    let replacement!: () => void;
    const persist = vi.fn(() => {
      expect(runtime.unregister).not.toHaveBeenCalled();
      replacement = runtime.register.mock.calls.at(-1)![1];
      replacement();
      expect(f.dispatch).not.toHaveBeenCalled();
    });
    expect(saveCaptureShortcutPreference('CmdOrCtrl+Alt+G', 'screenshot', persist, platform)).toBe(true);
    expect(runtime.register).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenCalledOnce();
    f.change('CmdOrCtrl+Alt+G');
    expect(runtime.register).toHaveBeenCalledTimes(3);
    expect(runtime.unregister.mock.calls).toEqual([[shortcut]]);
    original(); replacement();
    expect(f.dispatch.mock.calls).toEqual([['screenshot']]);
  });

  it('releases only its own keys on app quit and ignores late callbacks', () => {
    runtime.registered.mockImplementation(key => key === shortcut);
    const f = bind();
    expect(f.unavailable).toHaveBeenCalledWith(shortcut);
    const callback = runtime.register.mock.calls[0][1];
    runtime.on.mock.calls.find(([event]) => event === 'will-quit')![1]();
    expect(runtime.unregister.mock.calls).toEqual([['CmdOrCtrl+Shift+R']]);
    callback();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.change('CmdOrCtrl+Alt+G');
    expect(runtime.register).toHaveBeenCalledOnce();
  });
});

describe('capture shortcut availability', () => {
  it.each(['darwin', 'win32'] as const)('%s releases the successful probe before returning', platform => {
    expect(isCaptureShortcutAvailable(shortcut, platform)).toBe(true);
    expect(runtime.register).toHaveBeenCalledWith(shortcut, expect.any(Function));
    expect(runtime.unregister).toHaveBeenCalledOnce();
    expect(runtime.unregister).toHaveBeenCalledWith(shortcut);
    expect(runtime.register.mock.invocationCallOrder[0]).toBeLessThan(runtime.unregister.mock.invocationCallOrder[0]);
  });

  it('rejects an externally occupied key without unregistering anything', () => {
    runtime.register.mockReturnValue(false);
    expect(isCaptureShortcutAvailable(shortcut, 'darwin')).toBe(false);
    expect(runtime.unregister).not.toHaveBeenCalled();
  });

  it('preserves shortcuts already owned by this process', () => {
    runtime.registered.mockReturnValue(true);
    expect(isCaptureShortcutAvailable(shortcut, 'darwin')).toBe(false);
    expect(runtime.register).not.toHaveBeenCalled();
    expect(runtime.unregister).not.toHaveBeenCalled();
  });

  it('rejects unavailable runtime or registration exceptions', () => {
    runtime.ready.mockReturnValue(false);
    expect(isCaptureShortcutAvailable(shortcut, 'darwin')).toBe(false);
    expect(runtime.register).not.toHaveBeenCalled();
    runtime.ready.mockReturnValue(true);
    runtime.register.mockImplementation(() => { throw new Error('native registration failed'); });
    expect(isCaptureShortcutAvailable(shortcut, 'darwin')).toBe(false);
    expect(runtime.unregister).not.toHaveBeenCalled();
  });

  it('does not bind Linux portal shortcuts as an availability probe', () => {
    expect(isCaptureShortcutAvailable(shortcut, 'linux')).toBe(true);
    expect(runtime.ready).not.toHaveBeenCalled();
    expect(runtime.register).not.toHaveBeenCalled();
    expect(runtime.unregister).not.toHaveBeenCalled();
  });

  it('holds a temporary registration through persistence and releases it on write failure', () => {
    const persist = vi.fn(() => {
      expect(runtime.unregister).not.toHaveBeenCalled();
      throw new Error('write failed');
    });
    expect(() => saveCaptureShortcutPreference(shortcut, 'screenshot', persist, 'darwin')).toThrow('write failed');
    expect(persist).toHaveBeenCalledOnce();
    expect(runtime.unregister).toHaveBeenCalledWith(shortcut);
  });
});
