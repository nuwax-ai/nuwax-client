import type { CaptureRect, CaptureSize } from '@shared/features/capture/windowContract';

/** Exact window, exact main frame and exact generated document; source strings alone confer no trust. */
export function isTrustedCaptureFrame(
  event: { sender: unknown; senderFrame: unknown },
  contents: { isDestroyed(): boolean; mainFrame: unknown },
  documentUrl: string,
): boolean {
  if (contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
  const frame = event.senderFrame as { url?: string } | null;
  return !!frame && frame.url === documentUrl;
}
export function isValidCaptureCrop(value: unknown, source: CaptureSize): value is CaptureRect {
  if (!value || typeof value !== 'object') return false;
  const crop = value as CaptureRect;
  return [crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger)
    && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
    && crop.x + crop.width <= source.width && crop.y + crop.height <= source.height;
}
