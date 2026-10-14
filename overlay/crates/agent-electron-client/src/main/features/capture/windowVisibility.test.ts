import { describe, expect, it, vi } from 'vitest';
import { createCaptureWindowVisibility } from './windowVisibility';

function window(overrides: Record<string, unknown> = {}) {
  return { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true,
    getChildWindows: () => [], hide: vi.fn(), show: vi.fn(), showInactive: vi.fn(), ...overrides };
}
const log = { warn: vi.fn() };

describe('capture client window visibility', () => {
  it('hides visible client and child windows before settling, restoring their focus state', async () => {
    const child = window({ isFocused: () => false });
    const main = window({ getChildWindows: () => [child] });
    const visibility = createCaptureWindowVisibility({ getWindow: () => main as never, log, settleMs: 0 });
    const ready = visibility.hide(new AbortController().signal);
    expect(main.hide).toHaveBeenCalledOnce(); expect(child.hide).toHaveBeenCalledOnce();
    expect(main.show).not.toHaveBeenCalled();
    await ready; visibility.restore(); visibility.restore();
    expect(main.show).toHaveBeenCalledOnce(); expect(child.showInactive).toHaveBeenCalledOnce();
  });

  it.each([{ isVisible: () => false }, { isMinimized: () => true }, { isDestroyed: () => true }])
    ('does not reveal a previously hidden, minimized or destroyed window', async overrides => {
      const main = window(overrides);
      const visibility = createCaptureWindowVisibility({ getWindow: () => main as never, log });
      await visibility.hide(new AbortController().signal); visibility.restore();
      expect(main.hide).not.toHaveBeenCalled(); expect(main.show).not.toHaveBeenCalled();
    });

  it('canceling while the compositor settles releases the wait and restores the client', async () => {
    const main = window(); const abort = new AbortController();
    const visibility = createCaptureWindowVisibility({ getWindow: () => main as never, log, settleMs: 60000 });
    const ready = visibility.hide(abort.signal); abort.abort(); await ready; visibility.restore();
    expect(main.show).toHaveBeenCalledOnce();
  });

  it('does not restore destroyed windows or reopen the application during quit', async () => {
    const main = window(); let restore = true;
    const visibility = createCaptureWindowVisibility({ getWindow: () => main as never, log, settleMs: 0, canRestore: () => restore });
    await visibility.hide(new AbortController().signal); main.isDestroyed = () => true; visibility.restore();
    expect(main.show).not.toHaveBeenCalled();
    main.isDestroyed = () => false;
    await visibility.hide(new AbortController().signal); restore = false; visibility.restore();
    expect(main.show).not.toHaveBeenCalled();
  });
});
