import { describe, expect, it, vi } from 'vitest';
import { CAPTURE_SHORTCUT_ACK_IPC } from '@shared/features/capture/contract';
import { registerCaptureShortcutRouting, routeCaptureShortcut } from './shortcutRouting';

it('only the addressed current document can claim the focused-IM shortcut', async () => {
  let ack!: (event: unknown, value: unknown) => boolean;
  const dispose = registerCaptureShortcutRouting({ handle: (_ch: string, handler: typeof ack) => { ack = handler; } } as never);
  const frame = {};
  const target = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
  const pending = routeCaptureShortcut(target as never, 'screenshot');
  const [, { id }] = target.send.mock.calls[0];
  expect(ack({ sender: {}, senderFrame: frame }, { id, handled: true })).toBe(false);
  expect(ack({ sender: target, senderFrame: {} }, { id, handled: true })).toBe(false);
  expect(ack({ sender: target, senderFrame: frame }, { id, handled: true })).toBe(true);
  expect(await pending).toBe(true);
  expect(ack({ sender: target, senderFrame: frame }, { id, handled: true })).toBe(false);
  dispose();
});

it('expired claims cannot launch a second capture after the shell fallback', async () => {
  vi.useFakeTimers();
  try {
    const handlers = new Map<string, Function>();
    const dispose = registerCaptureShortcutRouting({ handle: (ch: string, handler: Function) => { handlers.set(ch, handler); } } as never);
    const target = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const pending = routeCaptureShortcut(target as never, 'mp4');
    const [, { id }] = target.send.mock.calls[0];
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe(false);
    expect(handlers.get(CAPTURE_SHORTCUT_ACK_IPC)!({ sender: target, senderFrame: target.mainFrame }, { id, handled: true })).toBe(false);
    dispose();
  } finally { vi.useRealTimers(); }
});
