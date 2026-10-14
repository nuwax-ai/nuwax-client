import { powerSaveBlocker } from 'electron';
import { desktopSource, portalSource } from './sources';
import { resolveCaptureWindowPolicy } from './windowing';
import type { CapturePlatformAdapter, CapturePowerBlocker } from './index';

/** Linux cannot exclude app windows from a captured display and may blank an idle desktop. */
export function createLinuxCapturePlatform(portal: boolean, injectedPower?: CapturePowerBlocker): CapturePlatformAdapter {
  return {
    source: portal ? portalSource : desktopSource,
    windows: resolveCaptureWindowPolicy('linux', portal),
    framePipeline: portal ? 'repeat-last-frame' : 'guarded-source',
    beginRecording() {
      const power = injectedPower ?? powerSaveBlocker;
      const id = power.start('prevent-display-sleep');
      let released = false;
      return () => { if (!released) { released = true; power.stop(id); } };
    },
  };
}
