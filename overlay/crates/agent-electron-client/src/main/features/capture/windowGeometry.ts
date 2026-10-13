import type { CaptureRect, CaptureSelection } from '@shared/features/capture/windowContract';
import { placeCaptureToolbar } from '@shared/features/capture/windowPlacement';

/** Source pixels to global desktop DIP, with the actual frame/display ratio on each axis. */
export function selectionDesktopRect(selection: CaptureSelection): CaptureRect {
  const { sourceSize, displayBounds, crop } = selection;
  const sx = displayBounds.width / sourceSize.width, sy = displayBounds.height / sourceSize.height;
  return { x: displayBounds.x + crop.x * sx, y: displayBounds.y + crop.y * sy, width: crop.width * sx, height: crop.height * sy };
}
/** Associate controls with the chosen display/region for the entire recording. */
export function recordingControlBounds(selection: CaptureSelection, workArea: CaptureRect, size = { width: 440, height: 60 }): CaptureRect {
  // DesktopCapturer does not provide window bounds. In window mode use the screen
  // where the user chose it, without treating the preview as real window geometry.
  return placeCaptureToolbar(selection.sourceKind === 'screen' ? selectionDesktopRect(selection) : null, workArea, size);
}
export function recordingBorderBounds(selection: CaptureSelection, margin = 3): CaptureRect {
  const target = selectionDesktopRect(selection);
  // H.264 can expand an odd crop by one source pixel on either edge. Keep the
  // visible stroke outside that extra real content even when OS exclusion fails.
  const gapX = selection.displayBounds.width / selection.sourceSize.width;
  const gapY = selection.displayBounds.height / selection.sourceSize.height;
  const left = Math.floor(target.x - gapX) - margin, top = Math.floor(target.y - gapY) - margin;
  return { x: left, y: top, width: Math.ceil(target.x + target.width + gapX) - left + margin, height: Math.ceil(target.y + target.height + gapY) - top + margin };
}
