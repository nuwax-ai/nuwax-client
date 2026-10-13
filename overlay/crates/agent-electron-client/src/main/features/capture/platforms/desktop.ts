import { desktopSource, portalSource } from './sources';
import { resolveCaptureWindowPolicy } from './windowing';
import type { CapturePlatformAdapter } from './index';

/** macOS and Windows share native desktop selection and protected controls. */
export function createDesktopCapturePlatform(platform: NodeJS.Platform, portal: boolean): CapturePlatformAdapter {
  return {
    source: portal ? portalSource : desktopSource,
    windows: resolveCaptureWindowPolicy(platform, portal),
    framePipeline: 'source',
    beginRecording: () => () => {},
  };
}
