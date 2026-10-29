/** Linux desktop capture cannot assume global coordinates on a Wayland compositor. */
export function usesCapturePortal(platform: NodeJS.Platform = process.platform,
  env: { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string } = process.env): boolean {
  return platform === 'linux' && (env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' || !!env.WAYLAND_DISPLAY);
}

export interface CaptureCommandLine {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value: string): void;
}

const featureNames = (value: string) => value.split(',').map(entry => entry.trim().split(/[<:]/)[0]).filter(Boolean);

/** Configure capture and global shortcut portals before app readiness. */
export function configureCaptureBackend(commandLine: CaptureCommandLine, platform: NodeJS.Platform = process.platform,
  env: { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string } = process.env): boolean {
  if (!captureBackendAvailable(commandLine, platform, env)) return false;
  if (!usesCapturePortal(platform, env)) return true;
  const enabled = commandLine.getSwitchValue('enable-features');
  const disabled = featureNames(commandLine.getSwitchValue('disable-features'));
  const missing = ['WebRTCPipeWireCapturer', 'GlobalShortcutsPortal']
    .filter(feature => !featureNames(enabled).includes(feature) && !disabled.includes(feature));
  if (missing.length) {
    commandLine.appendSwitch('enable-features', [enabled, ...missing].filter(Boolean).join(','));
  }
  return true;
}

/** An explicit PipeWire opt-out must never fall back to Xwayland capture. */
export function captureBackendAvailable(commandLine: Pick<CaptureCommandLine, 'getSwitchValue'>,
  platform: NodeJS.Platform = process.platform,
  env: { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string } = process.env): boolean {
  return !usesCapturePortal(platform, env) || !featureNames(commandLine.getSwitchValue('disable-features')).includes('WebRTCPipeWireCapturer');
}

export { CaptureCanceledError } from './captureErrors';
