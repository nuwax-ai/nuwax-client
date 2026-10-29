import type { BrowserWindow } from 'electron';

export interface CaptureWindowVisibility {
  hide(signal: AbortSignal): Promise<void>;
  restore(): void;
}

/** 隐藏发起截屏的宿主窗口；等桌面合成器刷新后才采集，结束时恢复原可见状态。 */
export function createCaptureWindowVisibility(options: {
  getWindow(): BrowserWindow | null;
  shouldHide?(): boolean;
  canRestore?(): boolean;
  log: { warn(...args: unknown[]): void };
  settleMs?: number;
}): CaptureWindowVisibility {
  let hidden: Array<{ window: BrowserWindow; focused: boolean }> = [];
  const restore = () => {
    const previous = hidden;
    hidden = [];
    if (options.canRestore?.() === false) return;
    for (const { window, focused } of previous) {
      if (window.isDestroyed()) continue;
      try { if (focused) window.show(); else window.showInactive(); }
      catch (error) { options.log.warn('[Capture] could not restore client window', error); }
    }
  };
  return {
    async hide(signal) {
      if (signal.aborted || options.shouldHide?.() === false) return;
      const parent = options.getWindow();
      if (!parent || parent.isDestroyed()) return;
      // 附属窗口一起隐藏，避免设置/弹出页面挡住目标；原先隐藏或最小化的窗口不恢复。
      const collect = (window: BrowserWindow): BrowserWindow[] => [window, ...window.getChildWindows().flatMap(collect)];
      hidden = collect(parent).filter(window => !window.isDestroyed() && window.isVisible() && !window.isMinimized())
        .map(window => ({ window, focused: window.isFocused() }));
      if (!hidden.length) return;
      for (const { window } of hidden) window.hide();
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, options.settleMs ?? 150);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
    },
    restore,
  };
}
