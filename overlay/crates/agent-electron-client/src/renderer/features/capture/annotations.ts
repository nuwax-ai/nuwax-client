export interface AnnotationPoint { x: number; y: number }
export interface CaptureAnnotation {
  tool: 'rectangle' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic';
  points: AnnotationPoint[];
  color: string;
  width: number;
  text?: string;
}

/** Self-contained so the native window can embed it without a renderer build entry. */
export function createAnnotationPainter() {
  function draw(ctx: CanvasRenderingContext2D, annotation: CaptureAnnotation): void {
    const { tool, points, color, width } = annotation;
    if (!points.length) return;
    const a = points[0];
    const b = points[points.length - 1];
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (tool === 'rectangle') ctx.rect(x, y, w, h);
    else if (tool === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (tool === 'arrow') {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(width * 4, 12);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.moveTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    } else if (tool === 'pen') {
      ctx.moveTo(a.x, a.y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      if (points.length === 1) ctx.lineTo(a.x + 0.1, a.y + 0.1);
    } else if (tool === 'text') {
      ctx.font = `${Math.max(12, width * 7)}px sans-serif`;
      ctx.textBaseline = 'top';
      (annotation.text || '').split('\n').forEach((line, i) => ctx.fillText(line, a.x, a.y + i * width * 8));
    } else if (tool === 'mosaic' && w > 0 && h > 0) {
      // Sample the current composition, so later annotations preserve draw order.
      const small = document.createElement('canvas');
      const block = Math.max(8, width * 4);
      small.width = Math.max(1, Math.ceil(w / block));
      small.height = Math.max(1, Math.ceil(h / block));
      const sample = small.getContext('2d')!;
      sample.drawImage(ctx.canvas, x, y, w, h, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
    }
    if (tool !== 'text' && tool !== 'mosaic') ctx.stroke();
    ctx.restore();
  }
  return { draw };
}

/** Undo stores whole immutable operations, never bitmap copies of a large screen. */
export function createAnnotationHistory<T>() {
  const done: T[] = [];
  const undone: T[] = [];
  return {
    values: () => done.slice(),
    push(value: T) { done.push(value); undone.length = 0; },
    undo() { const value = done.pop(); if (value !== undefined) undone.push(value); return value !== undefined; },
    redo() { const value = undone.pop(); if (value !== undefined) done.push(value); return value !== undefined; },
    clear() { done.length = 0; undone.length = 0; },
    canUndo: () => done.length > 0,
    canRedo: () => undone.length > 0,
  };
}
