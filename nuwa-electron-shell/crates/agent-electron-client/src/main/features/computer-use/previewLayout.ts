export const CUA_PREVIEW_INSET = 10;
export const CUA_PREVIEW_DEFAULT_EXTENT = 220;
export const clampPreviewExtent = (value: number) => Math.max(160, Math.min(640, value));

type Size = { width: number; height: number };
export type PreviewLayer = Size & { taskId: string; x: number; y: number };

/** Fit whole window images, including portrait windows, within one contained stack. */
export function previewLayout(layers: Array<Size & { taskId: string }>, area: Size, extent: number) {
  const offset = Math.max(0, layers.length - 1) * 8;
  const availableWidth = Math.max(1, area.width - 32);
  const availableHeight = Math.max(1, area.height - 64);
  // Reduce the inset on exceptionally small hosts rather than placing a child outside them.
  const inset = Math.min(CUA_PREVIEW_INSET, Math.max(0, (Math.min(availableWidth, availableHeight) - 1) / 2));
  const spacing = Math.min(offset, Math.max(0, Math.min(availableWidth, availableHeight) - inset * 2 - 1));
  const limit = Math.max(1, Math.min(clampPreviewExtent(extent), availableWidth - inset * 2 - spacing, availableHeight - inset * 2 - spacing));
  const sizes = layers.map(layer => {
    const scale = limit / Math.max(layer.width, layer.height);
    return { taskId: layer.taskId, width: Math.max(1, Math.round(layer.width * scale)), height: Math.max(1, Math.round(layer.height * scale)) };
  });
  const width = Math.max(1, ...sizes.map(layer => layer.width));
  const height = Math.max(1, ...sizes.map(layer => layer.height));
  return {
    width: Math.min(availableWidth, Math.ceil(width + spacing + inset * 2)),
    height: Math.min(availableHeight, Math.ceil(height + spacing + inset * 2)),
    layers: sizes.map((layer, index): PreviewLayer => ({ ...layer,
      x: Math.round(inset + width - layer.width + spacing * (1 - index / Math.max(1, sizes.length - 1))),
      y: Math.round(inset + height - layer.height + spacing * index / Math.max(1, sizes.length - 1)),
    })),
  };
}
