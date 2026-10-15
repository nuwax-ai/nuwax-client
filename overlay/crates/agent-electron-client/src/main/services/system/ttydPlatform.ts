import * as path from "path";
import * as fs from "fs";

/** Win10 1809 (17763) 之前没有系统 ConPTY，使用独立 WinPTY 后端。 */
export function needsLegacyTtyd(platform: string, release: string): boolean {
  if (platform !== "win32") return false;
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(release);
  return !!version && Number(version[1]) === 10 && Number(version[3]) < 17763;
}

export function resolveTtydBinary(options: {
  resourcesPath: string;
  platform: string;
  arch: string;
  release: string;
  exists?: (file: string) => boolean;
}): string {
  const { resourcesPath, platform, arch, release, exists = fs.existsSync } = options;
  const root = path.join(resourcesPath, "ttyd");
  if (needsLegacyTtyd(platform, release)) {
    // 资源缺失也返回兼容程序预期路径，让启动器明确报缺失；禁止回落到 ConPTY。
    return path.join(root, "legacy", `${platform}-${arch}`, "ttyd-legacy.exe");
  }
  const executable = platform === "win32" ? "ttyd.exe" : "ttyd";
  const binary = path.join(root, "binaries", `${platform}-${arch}`, executable);
  if (exists(binary)) return binary;
  return path.join(root, "bin", executable);
}
