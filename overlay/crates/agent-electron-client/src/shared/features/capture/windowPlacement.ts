import type { CaptureRect, CaptureSize } from './windowContract';

/** Used by both the selector and native recording windows. All inputs use the same DIP space.
 * Keep this function self-contained: it also runs in the sandboxed capture document. */
export function placeCaptureToolbar(target: CaptureRect | null, area: CaptureRect, requested: CaptureSize): CaptureRect {
  const margin = 12, gap = 12;
  const width = Math.min(requested.width, Math.max(1, area.width - margin * 2));
  const height = Math.min(requested.height, Math.max(1, area.height - margin * 2));
  const left = area.x + Math.min(margin, (area.width - width) / 2);
  const top = area.y + Math.min(margin, (area.height - height) / 2);
  const right = area.x + area.width - width - (left - area.x);
  const bottom = area.y + area.height - height - (top - area.y);
  const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)));
  if (target) {
    const x = clamp(target.x + target.width - width, left, right);
    const y = clamp(target.y + (target.height - height) / 2, top, bottom);
    const candidates = [
      { x, y: Math.ceil(target.y + target.height + gap), width, height },
      { x, y: Math.floor(target.y - gap - height), width, height },
      { x: Math.ceil(target.x + target.width + gap), y, width, height },
      { x: Math.floor(target.x - gap - width), y, width, height },
    ];
    for (const candidate of candidates) {
      if (candidate.x >= left && candidate.x <= right && candidate.y >= top && candidate.y <= bottom) return candidate;
    }
  }
  // Whole-screen / nearly whole-screen selections have no external space. Stay on
  // this monitor, above its Dock/taskbar, instead of silently moving to another.
  return { x: clamp(area.x + (area.width - width) / 2, left, right), y: Math.floor(bottom), width, height };
}
