/** Shared capture failures are independent of the source and encoding backends. */
export class CaptureRecordingError extends Error {
  constructor(readonly code: 'encoder-unavailable' | 'permission-denied' | 'failed', message: string) {
    super(message); this.name = 'CaptureRecordingError';
  }
}
export class CaptureCanceledError extends Error {
  readonly code = 'canceled';
}
