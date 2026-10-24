import path from "node:path";
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
    // 与 discoverInstalledApps 同一套 path.join，Linux CI 上分隔符才能对上 Slack.lnk。
    const startMenu = path.join(
      process.env.ProgramData ?? "C:\\ProgramData",
      "Microsoft", "Windows", "Start Menu", "Programs",
    );
    const tree: Record<string, string[]> = { [startMenu]: ["Slack.lnk"] };
    const io = {
      existsSync: (dir: string) => dir === startMenu,
      readdirSync: (dir: string) => (tree[dir] ?? []).map((name) => ({
        name, isDirectory: () => false, isFile: () => true,
      })),
    };
    const apps = await discoverInstalledApps("win32", io as any, vi.fn() as any);
    expect(apps.some((item) => item.id === "slack")).toBe(true);
  });
});
