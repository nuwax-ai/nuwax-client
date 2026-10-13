import type { CaptureWindowPolicy } from './types';

/** macOS and Windows both support protected controls beside a desktop region. */
export const desktopCaptureWindowPolicy: CaptureWindowPolicy = {
  selectionWindow: () => undefined,
  recordingHint: () => undefined,
  controls: {
    presentation: 'overlay', associatedWithDesktop: true, border: true,
    contentProtection: true, hideDuringRecording: false,
  },
};
