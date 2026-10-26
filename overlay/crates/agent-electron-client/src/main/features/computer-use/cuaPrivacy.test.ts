import { describe, expect, it, vi } from "vitest";
import { sanitizeCuaObservation, startScreenshotRetention, cleanupStaleScreenshots, isSensitiveObservation, listLocalScreenshotNames, redactObservationContent } from "./cuaPrivacy";

describe("cuaPrivacy", () => {
  it("detects secure fields and lock screens", () => {
    expect(isSensitiveObservation({ role: "AXSecureTextField" })).toBe(true);
    expect(isSensitiveObservation({ app: "Safari" })).toBe(false);
  });

  it("withholds image parts on sensitive observations", () => {
    const redacted = redactObservationContent([
      { type: "image", mimeType: "image/png" },
      { type: "text", text: "AXSecureTextField visible" },
    ]);
    expect(redacted[0]).toEqual({ type: "text", text: expect.stringContaining("sensitive frame withheld") });
  });

  it("lists and expires local screenshots", () => {
    const files = new Map([["shot.png", { isFile: () => true, isDirectory: () => false, name: "shot.png", mtimeMs: 0 }]]);
    const io = {
      existsSync: () => true,
      readdirSync: () => [{ name: "shot.png", isFile: () => true, isDirectory: () => false }],
      statSync: () => ({ mtimeMs: 0 }),
      rmSync: (full: string) => { files.delete(full.split(/[/\\]/).pop()!); },
    };
    expect(listLocalScreenshotNames("/home", io as any)).toEqual(["shot.png"]);
    expect(cleanupStaleScreenshots("/home", 10, 100, io as any)).toBe(1);
  });
});

it("withholds sensitive text and nested images rather than only top-level image fields", () => {
  const result = { content: [{ type: "text", text: "AXSecureTextField SYNTHETIC_SECRET" }],
    structuredContent: { is_password: true, nested: { jpeg: "SYNTHETIC_IMAGE" } } };
  sanitizeCuaObservation(result);
  expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_/);
  expect(JSON.stringify(result)).toContain("sensitive");
});
it("expires screenshots while idle, without another manual stop", () => {
  vi.useFakeTimers();
  const sweep = vi.fn(); const stop = startScreenshotRetention("/synthetic", sweep);
  try {
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop(); vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sweep).toHaveBeenCalledTimes(2);
  } finally { stop(); vi.useRealTimers(); }
});

it("never traverses installed helper bundles or upgrade backups during image cleanup", () => {
  const read = vi.fn(() => [
    { name: "Nuwax Computer Use.app", isDirectory: () => true, isFile: () => false },
    { name: "helper.backup-old", isDirectory: () => true, isFile: () => false },
  ]);
  const io = { existsSync: () => true, readdirSync: read, statSync: vi.fn(), rmSync: vi.fn() };
  expect(cleanupStaleScreenshots("/synthetic", 10, 100, io as any)).toBe(0);
  expect(read).toHaveBeenCalledTimes(1); expect(io.rmSync).not.toHaveBeenCalled();
});
