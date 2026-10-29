import type { BrowserWindow } from 'electron';
import type { CaptureRect } from '@shared/features/capture/windowContract';
import type { CaptureWindowPolicy } from './types';

/** Linux compositors do not offer reliable exclusion of capture control windows. */
const linuxPreviewWindowPolicy: CaptureWindowPolicy = {
  selectionWindow: () => undefined,
  recordingHint: labels => labels.linuxRecordingHint,
  controls: {
    presentation: 'preview', associatedWithDesktop: false, border: false,
    contentProtection: false, hideDuringRecording: true,
  },
};
export const linuxWaylandWindowPolicy = linuxPreviewWindowPolicy;
export const linuxX11WindowPolicy: CaptureWindowPolicy = {
  ...linuxPreviewWindowPolicy,
  controls: { ...linuxPreviewWindowPolicy.controls, associatedWithDesktop: true },
  selectionWindow(config, target) {
    if (config.kind !== 'selection' || config.presentation === 'preview') return undefined;
    return {
      options: { fullscreen: true, fullscreenable: true },
      didShow: window => window.setFullScreen(true),
      waitUntilReady: (window, isOwned, isShown) => waitForFullscreen(window, target, isOwned, isShown),
    };
  },
};

/** Await native mapping: GNOME may clamp the initial bounds to its dock/panels. */
async function waitForFullscreen(window: BrowserWindow, target: CaptureRect, isOwned: () => boolean, isShown: () => boolean): Promise<void> {
  const started = performance.now();
  let stable = 0;
  while (isOwned() && !window.isDestroyed()) {
    if (performance.now() - started > 15000) throw new Error('Linux screenshot selector could not cover the chosen display');
    const actual = window.getContentBounds();
    if (isShown() && window.isFullScreen() && actual.x === target.x && actual.y === target.y
      && actual.width === target.width && actual.height === target.height) {
      if (++stable >= 2) return;
    } else stable = 0;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Capture selector closed before fullscreen initialization');
}
