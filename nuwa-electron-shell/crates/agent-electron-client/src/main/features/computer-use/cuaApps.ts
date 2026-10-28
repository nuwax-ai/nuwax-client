import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeAppId } from "./cuaSafety";

const pexec = promisify(execFile);

export interface InstalledApp { id: string; label: string }

function unique(apps: InstalledApp[]): InstalledApp[] {
  const seen = new Set<string>();
  const out: InstalledApp[] = [];
  for (const app of apps) {
    const id = normalizeAppId(app.id || app.label);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: app.label || app.id });
    if (out.length >= 200) break;
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function fromDirectory(dir: string, suffix: RegExp, io = fs): InstalledApp[] {
  if (!io.existsSync(dir)) return [];
  try {
    return io.readdirSync(dir).filter((name) => suffix.test(name)).map((name) => ({
      id: name.replace(suffix, ""),
      label: name.replace(suffix, ""),
    }));
  } catch { return []; }
}

export async function discoverInstalledApps(
  platform = process.platform,
  io = fs,
  exec: typeof pexec = pexec,
): Promise<InstalledApp[]> {
  if (platform === "darwin") {
    const apps = fromDirectory("/Applications", /\.app$/i, io);
    try {
      const { stdout } = await exec("mdfind", ["kMDItemKind == 'Application'"], { timeout: 4000 });
      for (const line of stdout.split("\n")) {
        const base = path.basename(line.trim());
        if (base.endsWith(".app")) apps.push({ id: base.replace(/\.app$/i, ""), label: base.replace(/\.app$/i, "") });
      }
    } catch { /* mdfind 不可用时只保留 /Applications */ }
    return unique(apps);
  }
  if (platform === "win32") {
    const roots = [
      path.join(process.env.ProgramData ?? "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
      path.join(process.env.AppData ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs"),
    ];
    const apps: InstalledApp[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || !io.existsSync(dir)) return;
      try {
        for (const entry of io.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
          else if (/\.(lnk|exe)$/i.test(entry.name)) {
            const label = entry.name.replace(/\.(lnk|exe)$/i, "");
            apps.push({ id: normalizeAppId(label), label });
          }
        }
      } catch { /* 跳过不可读目录 */ }
    };
    for (const root of roots) walk(root, 0);
    return unique(apps);
  }
  return unique(fromDirectory("/usr/share/applications", /\.desktop$/i, io));
}
