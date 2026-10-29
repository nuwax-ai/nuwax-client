/** Platform decisions are composed once. The recorder remains one state machine. */
import type { RecordingConfig } from '@shared/features/capture/recordingContract';
import { usesCapturePortal } from '../linuxEnvironment';
import type { CaptureSourceStrategy } from './sources';
import type { CaptureWindowPolicy } from './windowing';
import { createLinuxCapturePlatform } from './linux';
import { createDesktopCapturePlatform } from './desktop';

export interface CapturePowerBlocker {
  start(type: 'prevent-display-sleep'): number;
  stop(id: number): void;
}
export interface CapturePlatformAdapter {
  readonly source: CaptureSourceStrategy;
  readonly windows: CaptureWindowPolicy;
  readonly framePipeline: RecordingConfig['framePipeline'];
  /** Called after source/geometry confirmation, before countdown; always released in finally. */
  beginRecording(): () => void;
}

export function resolveCapturePlatform(platform: NodeJS.Platform = process.platform, options: {
  portal?: boolean;
  powerSaveBlocker?: CapturePowerBlocker;
} = {}): CapturePlatformAdapter {
  const portal = options.portal ?? usesCapturePortal(platform);
  return platform === 'linux'
    ? createLinuxCapturePlatform(portal, options.powerSaveBlocker)
    : createDesktopCapturePlatform(platform, portal);
}
