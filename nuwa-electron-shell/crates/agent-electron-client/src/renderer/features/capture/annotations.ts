export interface AnnotationPoint { x: number; y: number }
export interface CaptureAnnotation {
  tool: 'rectangle' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic';
  points: AnnotationPoint[];
  color: string;
  width: number;
  text?: string;
  fontSize?: number;
}
export interface AnnotationBounds { x: number; y: number; width: number; height: number }

/** Self-contained so the native window can embed it without a renderer build entry. */
export function createAnnotationPainter() {
  const fontSize = (annotation: CaptureAnnotation) => annotation.fontSize ?? Math.max(12, annotation.width * 7);
  function bounds(ctx: CanvasRenderingContext2D, annotation: CaptureAnnotation): AnnotationBounds {
    const xs = annotation.points.map(p => p.x), ys = annotation.points.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    if (annotation.tool === 'text') {
      const size = fontSize(annotation), lines = (annotation.text || '').split('\n');
      ctx.save(); ctx.font = `${size}px sans-serif`;
      const width = Math.max(1, ...lines.map(line => ctx.measureText(line).width));
      ctx.restore();
      return { x, y, width, height: lines.length * size * 1.2 };
    }
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  function hitTest(ctx: CanvasRenderingContext2D, annotation: CaptureAnnotation, point: AnnotationPoint, tolerance: number): boolean {
    if (!annotation.points.length) return false;
    const box = bounds(ctx, annotation), { x, y } = point;
    const distance = (a: AnnotationPoint, b: AnnotationPoint) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
    };
    if (annotation.tool === 'arrow' || annotation.tool === 'pen') {
      const points = annotation.points;
      const limit = tolerance + annotation.width / 2;
      if (points.length === 1) return distance(points[0], points[0]) <= limit;
      for (let i = 1; i < points.length; i++) if (distance(points[i - 1], points[i]) <= limit) return true;
      if (annotation.tool === 'arrow') {
        const a = points[0], b = points[points.length - 1];
        const angle = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(annotation.width * 4, 12);
        return [-Math.PI / 6, Math.PI / 6].some(offset => distance(b, {
          x: b.x - head * Math.cos(angle + offset), y: b.y - head * Math.sin(angle + offset),
        }) <= limit);
      }
      return false;
    }
    if (annotation.tool === 'ellipse') {
      const rx = box.width / 2, ry = box.height / 2;
      return ((x - box.x - rx) / (rx + tolerance)) ** 2 + ((y - box.y - ry) / (ry + tolerance)) ** 2 <= 1;
    }
    return x >= box.x - tolerance && x <= box.x + box.width + tolerance && y >= box.y - tolerance && y <= box.y + box.height + tolerance;
  }
  function resize(ctx: CanvasRenderingContext2D, annotation: CaptureAnnotation, target: AnnotationBounds): CaptureAnnotation {
    const original = bounds(ctx, annotation);
    return { ...annotation, points: annotation.points.map(p => ({
      x: target.x + (p.x - original.x) / (original.width || 1) * target.width,
      y: target.y + (p.y - original.y) / (original.height || 1) * target.height,
    })) };
  }
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
      const size = fontSize(annotation);
      ctx.font = `${size}px sans-serif`;
      ctx.textBaseline = 'top';
      (annotation.text || '').split('\n').forEach((line, i) => ctx.fillText(line, a.x, a.y + i * size * 1.2));
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
  return { draw, bounds, hitTest, resize };
}

/** Undo stores whole immutable operations, never bitmap copies of a large screen. */
export function createAnnotationHistory<T>() {
  type Change = { index: number; before: T[]; after: T[] };
  const values: T[] = [];
  const done: Change[] = [], undone: Change[] = [];
  const apply = (change: Change, reverse = false) => {
    values.splice(change.index, (reverse ? change.after : change.before).length, ...(reverse ? change.before : change.after));
  };
  const commit = (change: Change) => { apply(change); done.push(change); undone.length = 0; };
  return {
    values: () => values.slice(),
    push(value: T) { commit({ index: values.length, before: [], after: [value] }); },
    replace(index: number, value: T | null) {
      if (index < 0 || index >= values.length || values[index] === value) return false;
      commit({ index, before: [values[index]], after: value === null ? [] : [value] }); return true;
    },
    undo() { const change = done.pop(); if (!change) return false; apply(change, true); undone.push(change); return true; },
    redo() { const change = undone.pop(); if (!change) return false; apply(change); done.push(change); return true; },
    clear() { values.length = 0; done.length = 0; undone.length = 0; },
    canUndo: () => done.length > 0,
    canRedo: () => undone.length > 0,
  };
}
