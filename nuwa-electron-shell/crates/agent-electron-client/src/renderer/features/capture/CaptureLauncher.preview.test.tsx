import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureCapabilities, CaptureMenuAction, CaptureSuccess, HostCaptureBridge } from '@shared/features/capture/contract';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)>, success: vi.fn(), error: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(value: unknown) {
    const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = value;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks.values[index]) : next; }];
  },
  useRef(value: unknown) {
    const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: value };
    return hooks.values[index];
  },
  useEffect(effect: () => void | (() => void)) { hooks.effects.push(effect); },
}));
vi.mock('antd', () => ({ Button: vi.fn(), Modal: vi.fn(), InputNumber: vi.fn(), Select: vi.fn(), Space: vi.fn(), message: { error: hooks.error, success: hooks.success } }));
import { CaptureLauncher } from './CaptureLauncher';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => { hooks.values.length = 0; hooks.effects.length = 0; hooks.cursor = 0; vi.clearAllMocks(); });
function fixture(mime: string) {
  let action: ((a: CaptureMenuAction) => void) | null = null;
  const result: CaptureSuccess = { success: true, resultId: 'preview-id', mime, bytes: 0, width: 20, height: 20, qualityUsed: 'high', hdrToneMapped: false };
  const capture: HostCaptureBridge = {
    getCapabilities: vi.fn(async () => ({ available: true, formats: { still: ['png'], video: ['mp4'], gif: true } } as CaptureCapabilities)),
    screenshot: vi.fn(async () => result), record: vi.fn(async () => result), readChunk: vi.fn(), release: vi.fn(), cancel: vi.fn(),
    onStateChange: () => () => {}, save: vi.fn(async () => ({ success: true })),
    copy: vi.fn(async () => ({ success: true, kind: mime === 'image/png' ? 'image' : 'file' } as const)),
  };
  const paint = () => {
    hooks.cursor = 0;
    const tree = CaptureLauncher({ capture, t: key => key, onActionReady: value => { action = value; } }) as React.ReactElement;
    return tree?.props.children[1].props;
  };
  paint(); const cleanup = hooks.effects.map(effect => effect());
  return { capture, start: (initial?: CaptureMenuAction) => action?.(initial ?? (mime === 'image/png' ? 'screenshot' : mime === 'image/gif' ? 'gif' : 'mp4')), paint, unmount: () => cleanup.forEach(off => off?.()) };
}
describe('预览复制交互', () => {
  it.each(['video/mp4', 'image/gif'])('%s 显示下载与剪贴板按钮，复制后可关闭并释放原结果', async mime => {
    const f = fixture(mime); await flush(); f.start(); await flush();
    const modal = f.paint(); const buttons = modal.footer.props.children;
    expect(modal.title).toBe('Claw.Capture.recordingPreview');
    expect(buttons[1].props.children).toBe('Claw.Capture.copyToClipboard');
    expect(buttons[2].props.children).toBe('Claw.Capture.download');
    buttons[1].props.onClick(); await flush();
    expect(f.capture.copy).toHaveBeenCalledWith('preview-id'); expect(f.capture.release).not.toHaveBeenCalled();
    expect(hooks.success).toHaveBeenCalled(); modal.onCancel();
    expect(f.capture.release).toHaveBeenCalledOnce(); f.unmount(); expect(f.capture.release).toHaveBeenCalledOnce();
  });
  it.each(['image/png', 'image/jpeg', 'image/webp'])('%s 确认后自动复制，无预览或分块读取，并释放一次', async mime => {
    const f = fixture(mime); await flush(); f.start('screenshot'); await flush();
    expect(f.capture.copy).toHaveBeenCalledOnce(); expect(f.capture.copy).toHaveBeenCalledWith('preview-id');
    expect(f.capture.readChunk).not.toHaveBeenCalled();
    expect(f.paint().open).toBe(false);
    expect(hooks.success).toHaveBeenCalledWith('Claw.Capture.imageCopied');
    expect(f.capture.release).toHaveBeenCalledOnce(); expect(f.capture.release).toHaveBeenCalledWith('preview-id');
    f.unmount(); expect(f.capture.release).toHaveBeenCalledOnce();
  });
  it.each(['failed', 'throw', 'missing'])('自动复制 %s 时提示失败、不弹框且释放结果', async failure => {
    const f = fixture('image/png');
    if (failure === 'missing') f.capture.copy = undefined;
    else if (failure === 'throw') vi.mocked(f.capture.copy!).mockRejectedValueOnce(new Error('clipboard unavailable'));
    else vi.mocked(f.capture.copy!).mockResolvedValueOnce({ success: false, code: 'failed' });
    await flush(); f.start(); await flush();
    expect(hooks.error).toHaveBeenCalledWith('Claw.Capture.copyFailed');
    expect(f.paint().open).toBe(false); expect(f.capture.release).toHaveBeenCalledOnce(); f.unmount();
  });
  it('自动复制期间保持并发锁，卸载后迟到复制只释放结果', async () => {
    const f = fixture('image/png'); let finish!: (r: { success: true; kind: 'image' }) => void;
    vi.mocked(f.capture.copy!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await flush(); f.start(); await flush(); f.start(); await flush();
    expect(f.capture.screenshot).toHaveBeenCalledOnce();
    expect(hooks.error).toHaveBeenLastCalledWith('Claw.Capture.error.busy');
    f.unmount(); finish({ success: true, kind: 'image' }); await flush();
    expect(hooks.success).not.toHaveBeenCalled(); expect(f.capture.release).toHaveBeenCalledOnce();
  });
  it('交互选区切换输出时按实际 MIME 决定复制还是预览', async () => {
    const f = fixture('image/gif');
    f.capture.interactive = vi.fn(async () => ({ success: true, resultId: 'gif', mime: 'image/gif', bytes: 0, width: 20, height: 20, qualityUsed: 'high', hdrToneMapped: false } as const));
    await flush(); f.start('screenshot'); await flush();
    expect(f.capture.interactive).toHaveBeenCalledWith({ action: 'screenshot', compression: { quality: 'high' }, maxDurationMs: 1_800_000 });
    expect(f.capture.screenshot).not.toHaveBeenCalled(); expect(f.capture.copy).not.toHaveBeenCalled();
    expect(f.paint().open).toBe(true); f.unmount();
  });
  it('正在复制时重复点击、关闭和保存均受门禁，失败后保留预览可重试', async () => {
    const f = fixture('video/mp4'); let finish!: (r: { success: false; code: 'failed' }) => void;
    vi.mocked(f.capture.copy!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await flush(); f.start(); await flush(); const modal = f.paint(); const buttons = modal.footer.props.children;
    buttons[1].props.onClick(); buttons[1].props.onClick(); buttons[2].props.onClick(); modal.onCancel();
    expect(f.capture.copy).toHaveBeenCalledOnce(); expect(f.capture.save).not.toHaveBeenCalled(); expect(f.capture.release).not.toHaveBeenCalled();
    expect(f.paint().closable).toBe(false); finish({ success: false, code: 'failed' }); await flush();
    expect(hooks.error).toHaveBeenCalledWith('Claw.Capture.copyFailed'); expect(f.paint().open).toBe(true);
    buttons[1].props.onClick(); await flush(); expect(f.capture.copy).toHaveBeenCalledTimes(2); f.unmount();
  });
  it('卸载期间迟到复制不显示提示，原结果只释放一次', async () => {
    const f = fixture('image/gif'); let finish!: (r: { success: true; kind: 'file' }) => void;
    vi.mocked(f.capture.copy!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await flush(); f.start(); await flush(); f.paint().footer.props.children[1].props.onClick();
    f.unmount(); finish({ success: true, kind: 'file' }); await flush();
    expect(hooks.success).not.toHaveBeenCalled(); expect(f.capture.release).toHaveBeenCalledOnce();
  });
});
