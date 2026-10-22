import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({}));
vi.mock("electron-log", () => ({ default: { warn: vi.fn() } }));
import { permissionDragChipHtml } from "./permissionDragChip";

const labels = {
  dragChipTitle: 'Drop <into> "System Settings"',
  dragChipHint: "Drag the {0} icon into the app list",
  dragChipManual: "Dragging is unavailable",
};
describe("permission drag chip window html", () => {
  const html = permissionDragChipHtml(labels);
  it("escapes injected labels and keeps the interpolation slot client-side", () => {
    expect(html).toContain("Drag the {0} icon");
    expect(html).not.toContain("Drop <into>");
    expect(html).toContain("\\u003cinto>");
  });
  it("ships a strict CSP with a per-instance script nonce", () => {
    expect(html).toMatch(
      /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-[0-9a-f]{32}'"/,
    );
    // once in the CSP header form, once in the script tag attribute form
    expect(html.match(/(nonce-|nonce=")[0-9a-f]{32}/g)).toHaveLength(2);
  });
  it("exposes one draggable chip plus keyboard and close affordances", () => {
    expect(html).toContain('id="chip" draggable="true"');
    expect(html).toContain('id="close"');
    expect(html).toContain("onkeydown");
    expect(html).toContain("api.drag()");
    expect(html).toContain("api.close()");
    expect(html).toContain("dragChipManual");
  });
});
