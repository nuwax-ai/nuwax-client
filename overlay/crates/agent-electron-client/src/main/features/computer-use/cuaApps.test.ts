import { describe, expect, it, vi } from "vitest";
import { discoverInstalledApps } from "./cuaApps";

describe("discoverInstalledApps", () => {
  it("reads macOS /Applications and mdfind results", async () => {
    const io = {
      existsSync: (dir: string) => dir === "/Applications",
      readdirSync: () => ["Safari.app", "1Password.app", "readme.txt"],
    };
    const exec = vi.fn(async () => ({ stdout: "/System/Applications/Notes.app\n" }));
    const apps = await discoverInstalledApps("darwin", io as any, exec as any);
    expect(apps.map((item) => item.id)).toEqual(["1password", "notes", "safari"]);
  });

  it("walks Windows Start Menu shortcuts", async () => {
    const tree: Record<string, string[]> = {
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs": ["Slack.lnk"],
    };
    const io = {
      existsSync: (dir: string) => dir in tree || /Programs$/.test(dir),
      readdirSync: (dir: string) => (tree[dir] ?? []).map((name) => ({
        name, isDirectory: () => false, isFile: () => true,
      })),
    };
    const apps = await discoverInstalledApps("win32", io as any, vi.fn() as any);
    expect(apps.some((item) => item.id === "slack")).toBe(true);
  });
});
