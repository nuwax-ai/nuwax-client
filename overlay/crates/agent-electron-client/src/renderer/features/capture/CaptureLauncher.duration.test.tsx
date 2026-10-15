import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputNumber } from 'antd';
import type { CaptureCapabilities, CaptureMenuAction, HostCaptureBridge } from '@shared/features/capture/contract';
import { RECORDING_DURATION_SETTING } from '@shared/features/capture/recordingPreferences';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)>, error: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(value: unknown) {
    const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = value;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = next; }];
  },
  useRef(value: unknown) {
    const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: value };
    return hooks.values[index];
  },
  useEffect(effect: () => void | (() => void)) { hooks.effects.push(effect); },
}));
vi.mock('react-dom', () => ({ createPortal: (tree: unknown) => tree }));
vi.mock('antd', () => ({ Button: vi.fn(), Modal: vi.fn(), InputNumber: vi.fn(), Select: vi.fn(), Space: vi.fn(), message: { error: hooks.error } }));
import { CaptureLauncher } from './CaptureLauncher';

const flush = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
beforeEach(() => { hooks.values.length = 0; hooks.effects.length = 0; hooks.cursor = 0; vi.clearAllMocks(); });
function mount(stored: unknown = null) {
  let action: ((a: CaptureMenuAction) => void) | null = null;
  const settings = { get: vi.fn(async () => stored), set: vi.fn(async (_key: string, _value: unknown) => true) };
  const capture = {
    getCapabilities: vi.fn(async () => ({ available: true, formats: { still: ['png'], video: ['mp4'], gif: true } } as CaptureCapabilities)),
    record: vi.fn(async () => ({ success: false, code: 'canceled' } as const)),
    screenshot: vi.fn(), cancel: vi.fn(), release: vi.fn(), readChunk: vi.fn(), save: vi.fn(), onStateChange: () => () => {},
  } as HostCaptureBridge;
  const paint = () => {
    hooks.cursor = 0;
    const tree = CaptureLauncher({ capture, settings, t: key => key, panelTarget: {} as Element, onActionReady: value => { action = value; } });
    const findInput = (node: unknown): React.ReactElement | null => {
      if (!React.isValidElement(node)) return null;
      if (node.type === InputNumber) return node;
      return React.Children.toArray((node.props as { children?: React.ReactNode }).children).map(findInput).find(Boolean) ?? null;
    };
    return findInput(tree)?.props;
  };
  paint(); const cleanup = hooks.effects.map(effect => effect());
  return { capture, settings, paint, start: () => action?.('mp4'), unmount: () => cleanup.forEach(off => off?.()) };
}

describe('recording duration settings', () => {
  it.each([null, 0, 61, '20', 1.5])('invalid or absent saved value %s defaults to 30 minutes', async saved => {
    const f = mount(saved); await flush();
    expect(f.paint()).toMatchObject({ value: 30, min: 1, max: 60 });
    f.start(); await flush();
    expect(f.capture.record).toHaveBeenCalledWith(expect.objectContaining({ maxDurationMs: 1_800_000 })); f.unmount();
  });

  it('loads the saved limit and persists edits before menu recordings use them', async () => {
    const f = mount(20); await flush();
    expect(f.settings.get).toHaveBeenCalledWith(RECORDING_DURATION_SETTING);
    expect(f.paint().value).toBe(20);
    f.paint().onChange(45); await flush();
    expect(f.settings.set).toHaveBeenCalledWith(RECORDING_DURATION_SETTING, 45);
    expect(f.paint().value).toBe(45);
    f.start(); await flush();
    expect(f.capture.record).toHaveBeenCalledWith(expect.objectContaining({ maxDurationMs: 2_700_000 })); f.unmount();
  });

  it('failed persistence retains the prior limit and invalid input never writes', async () => {
    const f = mount(15); await flush();
    f.paint().onChange(null); f.paint().onChange(61); f.paint().onChange(1.5);
    expect(f.settings.set).not.toHaveBeenCalled();
    f.settings.set.mockResolvedValueOnce(false); f.paint().onChange(40); await flush();
    expect(f.paint().value).toBe(15); expect(hooks.error).toHaveBeenCalledWith('Claw.Capture.durationSaveFailed');
    f.start(); await flush();
    expect(f.capture.record).toHaveBeenCalledWith(expect.objectContaining({ maxDurationMs: 900_000 })); f.unmount();
  });

  it('keeps input enabled while sequential writes finish and recordings wait for the latest value', async () => {
    const f = mount(30); await flush();
    let firstSaved!: (value: boolean) => void;
    f.settings.set.mockImplementationOnce(() => new Promise(resolve => { firstSaved = resolve; }));
    f.paint().onChange(4); await flush();
    expect(f.paint()).toMatchObject({ value: 4, disabled: false });
    f.paint().onChange(45); await flush();
    expect(f.paint().value).toBe(45);
    expect(f.settings.set).toHaveBeenCalledTimes(1);
    f.start(); await flush(); expect(f.capture.record).not.toHaveBeenCalled();
    firstSaved(true); await flush(); await flush();
    expect(f.settings.set.mock.calls).toEqual([[RECORDING_DURATION_SETTING, 4], [RECORDING_DURATION_SETTING, 45]]);
    expect(f.paint().value).toBe(45);
    expect(f.capture.record).toHaveBeenCalledWith(expect.objectContaining({ maxDurationMs: 2_700_000 })); f.unmount();
  });
});
