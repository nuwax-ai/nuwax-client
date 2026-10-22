import { describe, expect, it, vi } from "vitest";
import * as path from "path";
import { needsLegacyTtyd, resolveTtydBinary } from "./ttydPlatform";

describe("Windows terminal backend compatibility", () => {
  it.each([
    ["1507", 10240, true],
    ["1511", 10586, true],
    ["1607", 14393, true],
    ["1703", 15063, true],
    ["1709", 16299, true],
    ["1803", 17134, true],
    ["1809", 17763, false],
    ["1903", 18362, false],
    ["1909", 18363, false],
    ["2004", 19041, false],
    ["20H2", 19042, false],
    ["21H1", 19043, false],
    ["21H2", 19044, false],
    ["22H2", 19045, false],
  ])(
    "Windows 10 %s / Build %i selects the expected backend",
    (_label, build, legacy) => {
      expect(needsLegacyTtyd("win32", `10.0.${build}`)).toBe(legacy);
    },
  );
  it.each(["10.0.10586.0", "10.0.10586.1234", "10.0.17762", " 10.0.10586 \n"])(
    "selects WinPTY for %s",
    (release) => expect(needsLegacyTtyd("win32", release)).toBe(true),
  );
  it.each([
    "10.0.17763",
    "10.0.17763.1",
    "10.0.17764",
    " 10.0.19045 \n",
    "10.0.22000",
    "10.0.22621",
    "10.0.22631",
    "10.0.26100",
    "10.0.26200",
    "11.0.1",
  ])("keeps native ttyd for %s", (release) =>
    expect(needsLegacyTtyd("win32", release)).toBe(false),
  );
  it.each([
    "",
    "unknown",
    "1511",
    "1809",
    "22H2",
    "19045",
    "10.0",
    "10.0.0",
    "10.0.-1",
    "10.0.17763-preview",
    "10.0.17763.1.2",
    "10.0.99999999999999999999",
    "10.1.10586",
    "6.3.9600",
  ])(
    "does not assume ConPTY support for unverified kernel version %s",
    (release) => {
      expect(needsLegacyTtyd("win32", release)).toBe(true);
    },
  );
  it.each(["darwin", "linux"])("does not change %s", (platform) => {
    expect(needsLegacyTtyd(platform, "10.0.10586")).toBe(false);
    expect(needsLegacyTtyd(platform, "unknown")).toBe(false);
  });
  it.each(["10.0.10586", "unknown"])(
    "does not fall back to ConPTY when compatibility resources are missing for %s",
    (release) => {
      const exists = vi.fn(() => false);
      expect(
        resolveTtydBinary({
          resourcesPath: "/resources",
          platform: "win32",
          arch: "x64",
          release,
          exists,
        }),
      ).toBe(path.join("/resources", "ttyd/legacy/win32-x64/ttyd-legacy.exe"));
      expect(exists).not.toHaveBeenCalled();
    },
  );
  it("preserves platform binary priority and bin fallback", () => {
    for (const [platform, arch, release, executable] of [
      ["win32", "x64", "10.0.17763", "ttyd.exe"],
      ["darwin", "arm64", "25.0.0", "ttyd"],
      ["linux", "x64", "6.8.0", "ttyd"],
    ]) {
      const options = { resourcesPath: "/resources", platform, arch, release };
      expect(resolveTtydBinary({ ...options, exists: () => true })).toBe(
        path.join(
          "/resources",
          "ttyd/binaries",
          `${platform}-${arch}`,
          executable,
        ),
      );
      expect(resolveTtydBinary({ ...options, exists: () => false })).toBe(
        path.join("/resources", "ttyd/bin", executable),
      );
    }
  });
});
