import { randomBytes } from 'node:crypto';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { TrustedIpc } from '../_kit/trustedIpc';
import { CAPTURE_SHORTCUT_ACK_IPC, CAPTURE_SHORTCUT_REQUEST_IPC, type CaptureMenuAction } from '@shared/features/capture/contract';

let route: ((target: WebContents, action: CaptureMenuAction) => Promise<boolean>) | null = null;
export function routeCaptureShortcut(target: WebContents, action: CaptureMenuAction): Promise<boolean> {
  return route?.(target, action) ?? Promise.resolve(false);
}

/** The focused IM gets first refusal. Capture starts only after a trusted, timely claim is granted. */
export function registerCaptureShortcutRouting(ipc: TrustedIpc): () => void {
  const pending = new Map<string, { target: WebContents; frame: WebContents['mainFrame']; finish(value: boolean): void }>();
  ipc.handle<IpcMainInvokeEvent, [unknown], boolean>(CAPTURE_SHORTCUT_ACK_IPC, (event, raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const { id, handled } = raw as { id?: unknown; handled?: unknown };
    if (typeof id !== 'string' || typeof handled !== 'boolean') return false;
    const request = pending.get(id);
    if (!request || request.target !== event.sender || request.frame !== event.senderFrame || event.sender.isDestroyed()) return false;
    request.finish(handled);
    return handled;
  }, false);
  const ownRoute = (target: WebContents, action: CaptureMenuAction) => new Promise<boolean>(resolve => {
    if (target.isDestroyed()) { resolve(false); return; }
    const id = randomBytes(16).toString('hex');
    const finish = (value: boolean) => { clearTimeout(timer); pending.delete(id); resolve(value); };
    const timer = setTimeout(() => finish(false), 200);
    pending.set(id, { target, frame: target.mainFrame, finish });
    try { target.send(CAPTURE_SHORTCUT_REQUEST_IPC, { id, action }); }
    catch { finish(false); }
  });
  route = ownRoute;
  return () => {
    if (route === ownRoute) route = null;
    for (const request of pending.values()) request.finish(false);
  };
}
