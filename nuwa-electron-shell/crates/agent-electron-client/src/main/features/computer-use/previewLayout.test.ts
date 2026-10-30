import { describe, expect, it } from "vitest";
import { previewLayout } from "./previewLayout";

describe("whole-window thumbnail layout", () => {
  it.each([[320, 570], [1600, 900], [800, 800]])("preserves the complete %d×%d window", (width, height) => {
    const layout = previewLayout([{ taskId: "A", width, height }], { width: 960, height: 640 }, 220);
    const layer = layout.layers[0];
    expect(Math.abs(layer.width - layer.height * width / height)).toBeLessThanOrEqual(1);
    expect(Math.max(layer.width, layer.height)).toBe(220);
    expect(layout.width).toBe(layer.width + 20); expect(layout.height).toBe(layer.height + 20);
  });
  it("keeps independently shaped layers and their shadows inside the stack", () => {
    const sources = [{ taskId: "portrait", width: 320, height: 570 }, { taskId: "wide", width: 1600, height: 900 }];
    const layout = previewLayout(sources, { width: 960, height: 640 }, 300);
    for (const [index, layer] of layout.layers.entries()) {
      expect(layer.x).toBeGreaterThanOrEqual(10); expect(layer.y).toBeGreaterThanOrEqual(10);
      expect(layer.x + layer.width).toBeLessThanOrEqual(layout.width - 10);
      expect(layer.y + layer.height).toBeLessThanOrEqual(layout.height - 10);
      expect(Math.abs(layer.width - layer.height * sources[index].width / sources[index].height)).toBeLessThanOrEqual(1);
    }
    expect(layout.layers[0].x).toBeGreaterThan(layout.layers[1].x);
    expect(layout.layers[1].y).toBeGreaterThan(layout.layers[0].y);
  });
  it.each([[300, 180], [80, 90], [33, 65]])("contains a resized stack in a %d×%d host", (width, height) => {
    const layout = previewLayout([0, 1, 2, 3].map(i => ({ taskId: String(i), width: i % 2 ? 1600 : 320, height: i % 2 ? 900 : 570 })), { width, height }, 10000);
    expect(layout.width).toBeLessThanOrEqual(width); expect(layout.height).toBeLessThanOrEqual(height);
    for (const layer of layout.layers) {
      expect(layer.x).toBeGreaterThanOrEqual(0); expect(layer.y).toBeGreaterThanOrEqual(0);
      expect(layer.x + layer.width).toBeLessThanOrEqual(layout.width);
      expect(layer.y + layer.height).toBeLessThanOrEqual(layout.height);
    }
  });
});
