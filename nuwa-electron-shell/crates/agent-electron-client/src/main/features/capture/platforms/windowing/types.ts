import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import type { CaptureRect, CaptureWindowConfiguration, CaptureWindowLabels } from '@shared/features/capture/windowContract';

/** Native window behavior; the shared factory continues to own windows and IPC. */
export interface CaptureSelectorWindowPolicy {
  options: Pick<BrowserWindowConstructorOptions, 'fullscreen' | 'fullscreenable'>;
  didShow(window: BrowserWindow): void;
  waitUntilReady(window: BrowserWindow, isOwned: () => boolean, isShown: () => boolean): Promise<void>;
}
export interface CaptureWindowPolicy {
  selectionWindow(config: CaptureWindowConfiguration, bounds: CaptureRect): CaptureSelectorWindowPolicy | undefined;
  recordingHint(labels: CaptureWindowLabels): string | undefined;
  controls: {
    presentation: 'overlay' | 'preview';
    associatedWithDesktop: boolean;
    border: boolean;
    contentProtection: boolean;
    hideDuringRecording: boolean;
  };
}
