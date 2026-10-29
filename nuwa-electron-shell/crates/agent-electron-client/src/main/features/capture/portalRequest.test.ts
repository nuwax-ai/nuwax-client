import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { installPortalRequest, PIPEWIRE_DELEGATED_SOURCE } from './portalRequest';

function fixture() {
  let handler: any;
  let destroyed = false;
  const frame = { url: 'file:///owned/recording.html' };
  const session = { setDisplayMediaRequestHandler: vi.fn(value => { handler = value; }) };
  const window = { isDestroyed: () => destroyed, webContents: { mainFrame: frame, session } } as unknown as BrowserWindow;
  const fail = vi.fn();
  const dispose = installPortalRequest(window, frame.url, fail);
  const request = { frame, videoRequested: true, audioRequested: false, userGesture: true };
  const invoke = handler;
  return { session, frame, fail, dispose, request, invoke, destroy: () => { destroyed = true; } };
}

describe('one-document one-request portal delegation', () => {
  it('rejects iframe, non-gesture, audio and duplicate requests with null (not an invalid empty object)', () => {
    const f = fixture();
    for (const request of [{ ...f.request, frame: { url: f.frame.url } }, { ...f.request, frame: null },
      { ...f.request, userGesture: false }, { ...f.request, audioRequested: true }, { ...f.request, videoRequested: false }]) {
      const callback = vi.fn(); f.invoke(request, callback); expect(callback).toHaveBeenCalledWith(null);
    }
    const callback = vi.fn(); f.invoke(f.request, callback);
    expect(callback).toHaveBeenCalledOnce(); expect(callback).toHaveBeenCalledWith({ video: PIPEWIRE_DELEGATED_SOURCE });
    const duplicate = vi.fn(); f.invoke(f.request, duplicate); expect(duplicate).toHaveBeenCalledWith(null);
    f.dispose(); expect(f.session.setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null);
  });
  it.each(['dispose', 'navigate', 'destroy'])('does not grant a source after %s', reason => {
    const f = fixture();
    if (reason === 'dispose') f.dispose();
    else if (reason === 'navigate') f.frame.url = 'file:///another/document.html';
    else f.destroy();
    const callback = vi.fn(); f.invoke(f.request, callback);
    expect(callback).toHaveBeenCalledWith(null);
  });
  it('does not invoke a callback twice if native media grant fails', () => {
    const f = fixture(); const callback = vi.fn(() => { throw new Error('native media grant failed'); });
    f.invoke(f.request, callback); expect(callback).toHaveBeenCalledOnce();
    expect(f.fail).toHaveBeenCalledWith(expect.objectContaining({message:'native media grant failed'}));
  });
});
