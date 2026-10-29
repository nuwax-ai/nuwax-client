import * as path from "path";
import * as fs from "fs";

const CONPTY_MIN_WINDOWS_10_BUILD = 17763;

/** 按内核 Build 判断；1507/1511/22H2 等发行标签不能用作版本比较。 */
export function needsLegacyTtyd(platform: string, release: string): boolean {
  if (platform !== "win32") return false;
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(release.trim());
  // 解析失败不能视为支持 ConPTY；兼容后端也可用于较新 Windows。
  if (!version) return true;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  const build = Number(version[3]);
  if (![major, minor, build].every(Number.isSafeInteger) || build <= 0)
    return true;
  return !(
    major > 10 ||
    (major === 10 && minor === 0 && build >= CONPTY_MIN_WINDOWS_10_BUILD)
  );
}

export function resolveTtydBinary(options: {
  resourcesPath: string;
  platform: string;
  arch: string;
  release: string;
  exists?: (file: string) => boolean;
}): string {
  const {
    resourcesPath,
    platform,
    arch,
    release,
    exists = fs.existsSync,
  } = options;
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
