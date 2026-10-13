/**
 * 选区几何：覆盖层里的 DIP 坐标 ↔ 冻结帧 / 录制流上的物理像素。
 *
 * 输出尺寸永远等于选区的物理像素尺寸（不重采样）。分数缩放（如 125%）下，
 * 逐轴用「帧像素 / 显示 DIP」的实际比例换算，并对左右/上下边分别取整，
 * 避免宽度累计 1px 漂移。H.264 yuv420p 要求偶数宽高，这里给出尽量不动内容的对齐。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function assertPositiveSize(size: Size, name: string): void {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new RangeError(`${name} must have positive finite width and height`);
  }
}

/** 拖拽起止两点 → 规整选区（任意拖拽方向），并夹在 `bounds` 内。 */
export function normalizeSelection(a: Point, b: Point, bounds: Size): Rect {
  assertPositiveSize(bounds, "bounds");
  const clampX = (v: number) => Math.min(Math.max(v, 0), bounds.width);
  const clampY = (v: number) => Math.min(Math.max(v, 0), bounds.height);
  const x1 = clampX(Math.min(a.x, b.x));
  const x2 = clampX(Math.max(a.x, b.x));
  const y1 = clampY(Math.min(a.y, b.y));
  const y2 = clampY(Math.max(a.y, b.y));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * 覆盖层里的 DIP 选区 → 冻结帧上的物理像素矩形。
 *
 * @param selection 选区，DIP，相对显示器左上角
 * @param displayDip 该显示器的 DIP 尺寸（覆盖层窗口的内容尺寸）
 * @param frame 冻结帧的实际像素尺寸
 */
export function dipRectToFramePixels(
  selection: Rect,
  displayDip: Size,
  frame: Size,
): Rect {
  assertPositiveSize(displayDip, "displayDip");
  assertPositiveSize(frame, "frame");
  const sx = frame.width / displayDip.width;
  const sy = frame.height / displayDip.height;

  const left = Math.min(
    Math.max(Math.round(selection.x * sx), 0),
    frame.width - 1,
  );
  const top = Math.min(
    Math.max(Math.round(selection.y * sy), 0),
    frame.height - 1,
  );
  const right = Math.min(
    Math.max(Math.round((selection.x + selection.width) * sx), left + 1),
    frame.width,
  );
  const bottom = Math.min(
    Math.max(Math.round((selection.y + selection.height) * sy), top + 1),
    frame.height,
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface EvenAlignment {
  rect: Rect;
  /** 宽度仍为奇数且无处可扩，需要在右侧补 1px（编码器层补）。 */
  padRight: boolean;
  /** 高度仍为奇数且无处可扩，需要在底部补 1px。 */
  padBottom: boolean;
  /** 相对输入是否有任何调整。 */
  adjusted: boolean;
}

function alignAxis(
  start: number,
  length: number,
  max: number,
): { start: number; length: number; pad: boolean } {
  if (length % 2 === 0) return { start, length, pad: false };
  if (start + length < max) return { start, length: length + 1, pad: false };
  if (start > 0) return { start: start - 1, length: length + 1, pad: false };
  return { start, length, pad: true };
}

/**
 * 把选区调整为偶数宽高：优先向右/下多取 1px 真实内容，其次向左/上，
 * 整轴都是奇数且无处可扩时才要求编码器补 1px。
 */
export function toEvenSize(rect: Rect, frame: Size): EvenAlignment {
  assertPositiveSize(frame, "frame");
  const x = alignAxis(rect.x, rect.width, frame.width);
  const y = alignAxis(rect.y, rect.height, frame.height);
  const aligned: Rect = {
    x: x.start,
    y: y.start,
    width: x.length,
    height: y.length,
  };
  return {
    rect: aligned,
    padRight: x.pad,
    padBottom: y.pad,
    adjusted:
      aligned.x !== rect.x ||
      aligned.y !== rect.y ||
      aligned.width !== rect.width ||
      aligned.height !== rect.height ||
      x.pad ||
      y.pad,
  };
}
