import { desktopCaptureWindowPolicy } from './desktop';
import { linuxWaylandWindowPolicy, linuxX11WindowPolicy } from './linux';
import type { CaptureWindowPolicy } from './types';

export type { CaptureSelectorWindowPolicy, CaptureWindowPolicy } from './types';

/** Resolve once at composition time; capture sessions consume behavior, not OS names. */
export function resolveCaptureWindowPolicy(platform: NodeJS.Platform, portal: boolean): CaptureWindowPolicy {
  switch (platform) {
    case 'linux': return portal ? linuxWaylandWindowPolicy : linuxX11WindowPolicy;
    case 'darwin':
    case 'win32':
    default: return desktopCaptureWindowPolicy;
  }
}
