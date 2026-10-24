import { describe, expect, it } from "vitest";
import { cleanupStaleScreenshots, isSensitiveObservation, listLocalScreenshotNames, redactObservationContent } from "./cuaPrivacy";

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
