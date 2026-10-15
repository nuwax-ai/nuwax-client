import { describe, expect, it, vi } from "vitest";
import * as path from "path";
import { needsLegacyTtyd, resolveTtydBinary } from "./ttydPlatform";

describe("Windows terminal backend compatibility", () => {
  it.each(["10.0.10586", "10.0.10586.0", "10.0.14393", "10.0.17134", "10.0.17762"])(
    "selects WinPTY for %s", release => expect(needsLegacyTtyd("win32", release)).toBe(true),
  );
  it.each(["10.0.17763", "10.0.19045", "10.0.22631", "11.0.1", "unknown"])(
    "keeps native ttyd for %s", release => expect(needsLegacyTtyd("win32", release)).toBe(false),
  );
  it.each(["darwin", "linux"])("does not change %s", platform => {
    expect(needsLegacyTtyd(platform, "10.0.10586")).toBe(false);
  });
  it("does not fall back to ConPTY when compatibility resources are missing", () => {
    const exists = vi.fn(() => false);
    expect(resolveTtydBinary({ resourcesPath: "/resources", platform: "win32", arch: "x64", release: "10.0.10586", exists }))
      .toBe(path.join("/resources", "ttyd/legacy/win32-x64/ttyd-legacy.exe"));
    expect(exists).not.toHaveBeenCalled();
  });
  it("preserves platform binary priority and bin fallback", () => {
    for (const [platform, arch, release, executable] of [
      ["win32", "x64", "10.0.17763", "ttyd.exe"],
      ["darwin", "arm64", "25.0.0", "ttyd"],
      ["linux", "x64", "6.8.0", "ttyd"],
    ]) {
      const options = { resourcesPath: "/resources", platform, arch, release };
      expect(resolveTtydBinary({ ...options, exists: () => true }))
        .toBe(path.join("/resources", "ttyd/binaries", `${platform}-${arch}`, executable));
      expect(resolveTtydBinary({ ...options, exists: () => false }))
        .toBe(path.join("/resources", "ttyd/bin", executable));
    }
  });
});
