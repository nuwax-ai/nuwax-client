/** 本机录制偏好；主进程和设置界面共用边界，业务入口不能绕过用户设置。 */
export const RECORDING_DURATION_SETTING = 'capture.maxDurationMinutes';
export const DEFAULT_RECORDING_DURATION_MINUTES = 30;
export const MAX_RECORDING_DURATION_MINUTES = 60;
export const DEFAULT_RECORDING_DURATION_MS = DEFAULT_RECORDING_DURATION_MINUTES * 60_000;

export function recordingDurationMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_RECORDING_DURATION_MINUTES
    ? value : DEFAULT_RECORDING_DURATION_MINUTES;
}
