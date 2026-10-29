/**
 * Binary Locator — 各打包二进制文件的路径解析
 *
 * 提供 uv / ripgrep / node / lanproxy / ttyd / nuwaxcode / codex-acp
 * 等预置二进制的路径查找函数，以及 Electron 内置 Node.js 相关辅助。
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";
import { execFileSync, execSync } from "child_process";
import log from "electron-log";
import {
  getAppDataDir,
  getAppBinDir,
  getAppNodeModules,
  getResourcesPath,
} from "./appPaths";
import { isWindows } from "./shellEnv";
import { resolveTtydBinary } from "./ttydPlatform";

// ==================== Electron 内置 Node.js 路径 ====================

/** 获取 Electron 内置 Node.js 的 bin 目录路径 */
export function getElectronNodeBinDir(): string {
  try {
    const execDir = path.dirname(process.execPath);

    if (isWindows()) {
      const paths = [
        path.join(
          execDir,
          "resources",
          "app.asar.unpacked",
          "node_modules",
          "electron",
          "dist",
          "node_modules",
          "bin",
        ),
        path.join(
          execDir,
          "..",
          "Resources",
          "app.asar.unpacked",
          "node_modules",
          "electron",
          "dist",
          "node_modules",
          "bin",
        ),
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
      const electronFrameworkPath = path.join(
        execDir,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
        "Current",
        "node",
        "bin",
      );
      if (fs.existsSync(electronFrameworkPath)) return electronFrameworkPath;
    } else if (process.platform === "darwin") {
      const electronFrameworkPath = path.join(
        execDir,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
        "Current",
        "node",
        "bin",
      );
      if (fs.existsSync(electronFrameworkPath)) return electronFrameworkPath;
    } else {
      const electronFrameworkPath = path.join(
        execDir,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "electron",
        "dist",
        "node_modules",
        "bin",
      );
      if (fs.existsSync(electronFrameworkPath)) return electronFrameworkPath;
    }
  } catch (error) {
    log.warn(`[getElectronNodeBinDir] error: ${error}`);
  }
  return "";
}

// ==================== Bundled Node.js ====================

/** 获取 bundled Node.js 24 的 bin 目录 */
export function getBundledNodeBinDir(): string {
  const resourcesPath = getResourcesPath();
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x64";
  const nodePlatformKey = `${process.platform}-${arch}`;
  const nodeBinPath = path.join(resourcesPath, "node", nodePlatformKey, "bin");
  if (fs.existsSync(nodeBinPath)) {
    log.info(`[getBundledNodeBinDir] Using bundled Node.js: ${nodeBinPath}`);
    return nodeBinPath;
  }
  const devPath = path.join(
    process.cwd(),
    "resources",
    "node",
    nodePlatformKey,
    "bin",
  );
  if (fs.existsSync(devPath)) {
    log.info(
      `[getBundledNodeBinDir] Dev mode using bundled Node.js: ${devPath}`,
    );
    return devPath;
  }
  return "";
}

export function getNodeBinPath(): string | null {
  const platformKey = `${process.platform}-${process.arch}`;
  const nodeName = isWindows() ? "node.exe" : "node";
  const nodePath = path.join(
    getResourcesPath(),
    "node",
    platformKey,
    "bin",
    nodeName,
  );
  if (!fs.existsSync(nodePath)) {
    log.warn(`[Dependencies] Bundled Node.js not found: ${nodePath}`);
    log.warn(
      '[Dependencies] Run "npm run prepare:node" to download Node.js resources',
    );
    return null;
  }
  return nodePath;
}

export function getNodeBinPathWithFallback(): string | null {
  const bundledPath = getNodeBinPath();
  if (bundledPath) return bundledPath;
  if (!isWindows()) {
    const systemNode = findSystemNode();
    if (systemNode) {
      log.info(`[Dependencies] Using system Node.js fallback: ${systemNode}`);
      return systemNode;
    }
  }
  return null;
}

function findSystemNode(): string | null {
  try {
    const cmd = isWindows() ? "where node" : "which node";
    const result = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
    const firstLine = result.split("\n")[0].trim();
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {
    // node not found in PATH
  }
  return null;
}

// ==================== uv ====================

/** 获取 bundled uv 二进制路径 */
export function getUvBinPath(): string {
  const uvName = isWindows() ? "uv.exe" : "uv";
  return path.join(getResourcesPath(), "uv", "bin", uvName);
}

/**
 * 若 bundled uv 不存在但 resources/uv/bin 有文件，复制到 ~/.nuwaclaw/bin 供子进程使用。
 * 每次 getAppEnv() 调用时触发，幂等。
 */
export function ensureUvInAppBin(): void {
  try {
    const uvBinPath = getUvBinPath();
    if (fs.existsSync(uvBinPath)) return;
    const appBin = getAppBinDir();
    const uvName = isWindows() ? "uv.exe" : "uv";
    const appBinUv = path.join(appBin, uvName);
    if (fs.existsSync(appBinUv)) return;
    const srcBin = path.join(getResourcesPath(), "uv", "bin");
    const srcUv = path.join(srcBin, uvName);
    const srcExists = fs.existsSync(srcUv);
    const srcBinIsDir =
      fs.existsSync(srcBin) && fs.statSync(srcBin).isDirectory();
    log.info(
      `[ensureUvInAppBin] resources/uv/bin: ${srcBin}, uvExists=${srcExists}, isDir=${srcBinIsDir}`,
    );
    if (!srcExists || !srcBinIsDir) return;
    if (!fs.existsSync(appBin)) fs.mkdirSync(appBin, { recursive: true });
    for (const name of fs.readdirSync(srcBin)) {
      const src = path.join(srcBin, name);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(appBin, name));
        log.info(`[ensureUvInAppBin] Copied bundled uv: ${name} -> ${appBin}`);
      }
    }
    log.info(`[ensureUvInAppBin] Copy complete, appBin=${appBin}`);
  } catch (e) {
    log.warn("[ensureUvInAppBin] Bundled uv check/copy failed:", e);
  }
}

// ==================== ripgrep ====================

export function getRipgrepBinPath(): string {
  const rgName = isWindows() ? "rg.exe" : "rg";
  return path.join(getResourcesPath(), "ripgrep", "bin", rgName);
}

// ==================== Git ====================

/** 与 prepare-git findPortableGitBash 一致的 bash 候选路径 */
function getBundledGitBashCandidates(resourcesPath: string): string[] {
  return [
    path.join(resourcesPath, "git", "bin", "bash.exe"),
    path.join(resourcesPath, "git", "usr", "bin", "bash.exe"),
    path.join(resourcesPath, "git", "mingw64", "bin", "bash.exe"),
    path.join(resourcesPath, "git", "mingw64", "usr", "bin", "bash.exe"),
  ];
}

/** 获取 bundled Git bin 目录（仅 Windows） */
export function getBundledGitBinDir(): string {
  if (!isWindows()) return "";
  const resourcesPath = getResourcesPath();
  const gitBinCandidates = [
    path.join(resourcesPath, "git", "bin"),
    path.join(resourcesPath, "git", "mingw64", "bin"),
  ];
  for (const gitBinPath of gitBinCandidates) {
    if (fs.existsSync(gitBinPath)) {
      log.info(`[getBundledGitBinDir] Using bundled Git: ${gitBinPath}`);
      return gitBinPath;
    }
  }
  const devCandidates = [
    path.join(process.cwd(), "resources", "git", "bin"),
    path.join(process.cwd(), "resources", "git", "mingw64", "bin"),
  ];
  for (const devPath of devCandidates) {
    if (fs.existsSync(devPath)) {
      log.info(`[getBundledGitBinDir] Dev mode using bundled Git: ${devPath}`);
      return devPath;
    }
  }
  return "";
}

/** 获取 bundled git-bash 路径（仅 Windows，不探测系统 Git for Windows） */
export function getBundledGitBashPath(): string {
  if (!isWindows()) return "";
  const resourcesPath = getResourcesPath();
  for (const p of getBundledGitBashCandidates(resourcesPath)) {
    if (fs.existsSync(p)) {
      log.info(`[getBundledGitBashPath] Using bundled git-bash: ${p}`);
      return p;
    }
  }
  for (const p of getBundledGitBashCandidates(
    path.join(process.cwd(), "resources"),
  )) {
    if (fs.existsSync(p)) {
      log.info(`[getBundledGitBashPath] Dev mode using bundled git-bash: ${p}`);
      return p;
    }
  }
  return "";
}

/** @deprecated 使用 getBundledGitBashPath；仅返回应用包内 bundled Git Bash */
export function resolveGitBashExecutable(): string {
  return getBundledGitBashPath();
}

// ==================== lanproxy ====================

/**
 * lanproxy 客户端入口脚本。由 prepare-lanproxy 在构建期把 src/main/services/lanproxy/cli.ts
 * 打成单文件，运行时用 Electron 内置 Node（ELECTRON_RUN_AS_NODE）执行，不再随包携带原生可执行文件。
 */
export function getLanproxyEntryPath(): string {
  return path.join(getResourcesPath(), "lanproxy", "bin", "lanproxy-client.js");
}

// ==================== ttyd ====================

export function getTtydBinPath(): string {
  return resolveTtydBinary({
    resourcesPath: getResourcesPath(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
  });
}

// ==================== nuwaxcode ====================

const NUWAXCODE_REQUIRED_VERSION = "1.17.11";

let cachedNuwaxcodeCheck: {
  file: string;
  size: number;
  mtimeMs: number;
  expectedHash: string;
  valid: boolean;
} | null = null;

function isDownloadedNuwaxcodeValid(binary: string, hashFile: string): boolean {
  const expectedHash = fs.readFileSync(hashFile, "utf-8").trim();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const stat = fs.statSync(binary);
  if (cachedNuwaxcodeCheck?.file === binary &&
      cachedNuwaxcodeCheck.size === stat.size &&
      cachedNuwaxcodeCheck.mtimeMs === stat.mtimeMs &&
      cachedNuwaxcodeCheck.expectedHash === expectedHash) {
    return cachedNuwaxcodeCheck.valid;
  }
  const actualHash = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  let valid = actualHash === expectedHash;
  if (valid) {
    try {
      valid = execFileSync(binary, ["-v"], {
        encoding: "utf-8", stdio: "pipe", timeout: 10000, windowsHide: true,
      }).trim().replace(/^v/, "") === NUWAXCODE_REQUIRED_VERSION;
    } catch {
      valid = false;
    }
  }
  cachedNuwaxcodeCheck = {
    file: binary, size: stat.size, mtimeMs: stat.mtimeMs, expectedHash, valid,
  };
  return valid;
}

export function getNuwaxcodeBundledBinPath(): string | null {
  const platformMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
    arm: "arm",
  };
  const platform = platformMap[os.platform()] || os.platform();
  const arch = archMap[os.arch()] || os.arch();
  const binary = platform === "windows" ? "nuwaxcode.exe" : "nuwaxcode";
  const bundledPath = path.join(
    getResourcesPath(),
    "nuwaxcode",
    `${platform}-${arch}`,
    "bin",
    binary,
  );
  const bundledVersionFile = path.join(getResourcesPath(), "nuwaxcode", ".version");
  try {
    if (fs.existsSync(bundledPath) &&
        fs.readFileSync(bundledVersionFile, "utf-8").trim() === NUWAXCODE_REQUIRED_VERSION) {
      return bundledPath;
    }
  } catch {}

  // 回退：应用数据目录（nuwaxcode 运行时下载通道的安装位置，
  // 目录布局与 resources 打包布局一致）
  const downloadedPath = path.join(
    getAppDataDir(),
    "nuwaxcode",
    `${platform}-${arch}`,
    "bin",
    binary,
  );
  // 旧版 AppData 缓存没有平台版本标记；不能仅凭文件存在就作为新版本启动。
  const downloadedVersionFile = path.join(
    getAppDataDir(), "nuwaxcode", `${platform}-${arch}`, ".version",
  );
  const downloadedHashFile = path.join(
    getAppDataDir(), "nuwaxcode", `${platform}-${arch}`, ".sha256",
  );
  try {
    if (fs.existsSync(downloadedPath) &&
        fs.readFileSync(downloadedVersionFile, "utf-8").trim() === NUWAXCODE_REQUIRED_VERSION &&
        isDownloadedNuwaxcodeValid(downloadedPath, downloadedHashFile)) {
      return downloadedPath;
    }
  } catch {}
  return null;
}

// ==================== codex-acp ====================

export function getCodexAcpBundledBinPath(): string | null {
  const platformMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
    arm: "arm",
  };
  const platform = platformMap[os.platform()] || os.platform();
  const arch = archMap[os.arch()] || os.arch();
  const binary =
    platform === "windows" ? "nuwax-codex-acp.exe" : "nuwax-codex-acp";
  const bundledPath = path.join(
    getResourcesPath(),
    "codex-acp",
    `${platform}-${arch}`,
    "bin",
    binary,
  );
  return fs.existsSync(bundledPath) ? bundledPath : null;
}

export function getCodexAcpBundledDir(): string | null {
  const bundledDir = path.join(getResourcesPath(), "codex-acp");
  return fs.existsSync(path.join(bundledDir, ".version")) ? bundledDir : null;
}

// ==================== windows-mcp ====================

export function getWindowsMcpBinPath(): string | null {
  if (os.platform() !== "win32") return null;
  const bundledPath = path.join(
    getResourcesPath(),
    "windows-mcp",
    "bin",
    "windows-mcp.exe",
  );
  return fs.existsSync(bundledPath) ? bundledPath : null;
}

// ==================== bundled package dirs ====================

export function getNuwaxFileServerBundledDir(): string | null {
  const bundledDir = path.join(getResourcesPath(), "nuwax-file-server");
  return fs.existsSync(path.join(bundledDir, "package.json"))
    ? bundledDir
    : null;
}

export function getClaudeCodeAcpBundledDir(): string | null {
  const bundledDir = path.join(getResourcesPath(), "claude-code-acp-ts");
  return fs.existsSync(path.join(bundledDir, "package.json"))
    ? bundledDir
    : null;
}

/**
 * @nuwax-ai/nuwax-harness-acp-ts（TS adapter）bundled dir。codex 引擎经 adapter
 * （dist/index.js）spawn，引擎二进制在 vendor/nuwax-harness/<ver>/ 下，运行时由
 * resolveBundledHarnessEnginePath 定位并经 NUWAX_PATH 注入（adapter 不再按包相对
 * 路径找引擎，homedir 缓存兜底在隔离 HOME 下落空）。
 */
export function getCodexAcpTsBundledDir(): string | null {
  const bundledDir = path.join(getResourcesPath(), "nuwax-harness-acp-ts");
  return fs.existsSync(path.join(bundledDir, "package.json"))
    ? bundledDir
    : null;
}

/** 引擎缓存平台三元组，与引擎包 bin/runtime.js 对齐；linux-x64 musl 优先。 */
function harnessTargetTriples(): string[] {
  const { platform, arch } = process;
  if (platform === "darwin") {
    if (arch === "arm64") return ["aarch64-apple-darwin"];
    if (arch === "x64") return ["x86_64-apple-darwin"];
  } else if (platform === "linux") {
    if (arch === "arm64") return ["aarch64-unknown-linux-musl"];
    if (arch === "x64") {
      return ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"];
    }
  } else if (platform === "win32") {
    if (arch === "arm64") return ["aarch64-pc-windows-msvc"];
    if (arch === "x64") return ["x86_64-pc-windows-msvc"];
  }
  return [];
}

/**
 * codex 引擎（nuwax-harness）二进制的绝对路径，作为 spawn env NUWAX_PATH 的值。
 *
 * adapter 只认 NUWAX_PATH/CODEX_PATH；其 homedir() 缓存兜底在 ACP 子进程的隔离
 * HOME 下必然落空，因此必须显式注入。bundled vendor 优先；npm 兜底安装的 adapter
 * 依赖真实 HOME 下由引擎包 postinstall 填充的 ~/.nuwax-harness-cache。
 */
export function resolveBundledHarnessEnginePath(): string | null {
  const binaryName =
    process.platform === "win32" ? "nuwax-harness.exe" : "nuwax-harness";
  const bundledDir = getCodexAcpTsBundledDir();
  if (bundledDir) {
    const vendorRoot = path.join(bundledDir, "vendor", "nuwax-harness");
    try {
      const hit = fs
        .readdirSync(vendorRoot)
        .map((ver) => path.join(vendorRoot, ver, binaryName))
        .find((candidate) => fs.existsSync(candidate));
      if (hit) return hit;
    } catch {
      log.warn(
        "[BinaryLocator] harness vendor dir unreadable, falling back to npm cache",
      );
    }
  }
  try {
    const enginePkgPath = path.join(
      getAppNodeModules(),
      "@nuwax-ai",
      "nuwax-harness",
      "package.json",
    );
    const version = JSON.parse(
      fs.readFileSync(enginePkgPath, "utf-8"),
    ).version as string;
    for (const triple of harnessTargetTriples()) {
      const candidate = path.join(
        os.homedir(),
        ".nuwax-harness-cache",
        version,
        triple,
        binaryName,
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // npm 兜底未安装引擎包：保持 null，由调用方 warn
  }
  return null;
}
