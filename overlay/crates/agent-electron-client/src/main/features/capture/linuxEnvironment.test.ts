import { describe, expect, it, vi } from 'vitest';
import { captureBackendAvailable, configureCaptureBackend, usesCapturePortal } from './linuxEnvironment';

describe('Linux capture environment', () => {
  it('uses portal for Wayland including Xwayland applications', () => {
    expect(usesCapturePortal('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe(true);
    expect(usesCapturePortal('linux', { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });
  it('keeps X11 and the existing desktop platforms on the overlay path', () => {
    expect(usesCapturePortal('linux', { XDG_SESSION_TYPE: 'x11' })).toBe(false);
    expect(usesCapturePortal('linux', {})).toBe(false);
    expect(usesCapturePortal('win32', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(usesCapturePortal('darwin', { XDG_SESSION_TYPE: 'wayland' })).toBe(false);
  });
  it('merges PipeWire into the existing enabled features only for Wayland', () => {
    const commandLine = { getSwitchValue: vi.fn((name: string): string => name === 'enable-features' ? 'ExistingFeature,AnotherFeature' : ''), appendSwitch: vi.fn() };
    expect(configureCaptureBackend(commandLine,'linux',{XDG_SESSION_TYPE:'wayland'})).toBe(true);
    expect(commandLine.appendSwitch).toHaveBeenCalledWith('enable-features','ExistingFeature,AnotherFeature,WebRTCPipeWireCapturer');
    commandLine.appendSwitch.mockClear(); configureCaptureBackend(commandLine,'linux',{XDG_SESSION_TYPE:'x11'});
    configureCaptureBackend(commandLine,'darwin',{XDG_SESSION_TYPE:'wayland'});
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
  it('does not duplicate an existing PipeWire feature or override an explicit opt-out', () => {
    const commandLine = { getSwitchValue: vi.fn((name: string): string => name === 'enable-features' ? 'WebRTCPipeWireCapturer<Study,Other' : ''), appendSwitch: vi.fn() };
    expect(configureCaptureBackend(commandLine,'linux',{WAYLAND_DISPLAY:'wayland-0'})).toBe(true);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
    commandLine.getSwitchValue.mockImplementation(name => name === 'disable-features' ? 'Other,WebRTCPipeWireCapturer' : 'Enabled');
    expect(configureCaptureBackend(commandLine,'linux',{WAYLAND_DISPLAY:'wayland-0'})).toBe(false);
    expect(captureBackendAvailable(commandLine,'linux',{WAYLAND_DISPLAY:'wayland-0'})).toBe(false);
    expect(captureBackendAvailable(commandLine,'linux',{XDG_SESSION_TYPE:'x11'})).toBe(true);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
