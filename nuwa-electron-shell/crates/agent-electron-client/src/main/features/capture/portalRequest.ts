import type { BrowserWindow, Session, Streams } from 'electron';

/** PipeWire delegates the actual source choice to its system picker when this stream starts.
 * This token is not a display ID or a screen chosen by the application.
 * Electron 40's DisplayMediaDeviceChosen accepts the source id/name pair.
 */
export const PIPEWIRE_DELEGATED_SOURCE = { id: 'screen:0:0', name: 'System desktop source' };

/** One owned document may request one portal source. No request can leak into another capture. */
export function installPortalRequest(window: BrowserWindow, url: string, fail: (error: Error) => void): () => void {
  const session: Session = window.webContents.session;
  let consumed = false;
  let disposed = false;
  session.setDisplayMediaRequestHandler((request, callback) => {
    if (disposed || window.isDestroyed() || request.frame !== window.webContents.mainFrame ||
      request.frame.url !== url || !request.videoRequested || request.audioRequested ||
      !request.userGesture || consumed) { callback(null as unknown as Streams); return; }
    consumed = true;
    try {
      // Calling desktopCapturer.getSources here would create and then dispose a
      // separate PipeWire portal session, asking the user to choose twice.
      // This one getDisplayMedia stream owns the picker, preview and recording.
      callback({ video: PIPEWIRE_DELEGATED_SOURCE as Streams['video'] });
    } catch (raw) {
      const error = raw instanceof Error ? raw : new Error(String(raw));
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') Object.assign(error, { code: 'permission-denied' });
      if (!disposed) fail(error);
    }
  });
  return () => { disposed = true; session.setDisplayMediaRequestHandler(null); };
}
