import type { CaptureMenuAction } from '@shared/features/capture/contract';
import type { CaptureSelection } from '@shared/features/capture/windowContract';
import type { StillCapture } from './captureService';

/** Trusted selector completion; stays inside one busy session and reuses its selected pixels. */
export class CaptureModeSwitch extends Error {
  constructor(readonly action: CaptureMenuAction, readonly selected: StillCapture | CaptureSelection) {
    super('Capture mode changed');
  }
}
