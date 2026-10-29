/**
 * nuwaxcode 运行时补装：从固定 SHA256 的官方 GitHub Release 获取。
 * 所有内容先解压到临时目录，校验完成后才替换应用数据目录中的旧版本。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import log from "electron-log";
import { getAppDataDir } from "./appPaths";

const NUWAXCODE_VERSION = "1.17.11";
const RELEASE_BASE =
  `https://github.com/nuwax-ai/nuwaxcode/releases/download/v${NUWAXCODE_VERSION}`;

/** 官方稳定版 v1.17.11 Release tar.gz 的 GitHub digest。 */
const RELEASE_SHA256: Record<string, string> = {
  "darwin-arm64": "9df3c3c08973fb8c9f4297cccc8f516892e573c46c7879831d96a7bb8fed7438",
  "darwin-x64": "e7c58fe220c2b8c45541c4ea46f92c152434ed9a5679dd4d42c7d6adfbfd585d",
  "linux-arm64": "087e6b14aeb20128cd887f4580b2c8cbbdca994bb1e2cc6575cfea24aaa17008",
  "linux-x64": "84b9ddde59ba473deb321304a6bfd1e9723e2ec04ecac04e1eee5f7ca563f575",
  "windows-arm64": "23fdbf443b175d19fd6fd1eb16bfaad2bc57b2c52782b4eb74b636242107e13f",
  "windows-x64": "54ee92454f655c176070865b6b02d0c0ef28191422e39aa1fe9b99f1b16b7e66",
};

type DownloadResult = { success: boolean; version: string; binPath?: string; error?: string };

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function downloadTo(url: string, target: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

function extractArchive(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    const windowsRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const tar = process.platform === "win32"
      ? path.join(windowsRoot, "System32", "tar.exe")
      : "tar";
    if (process.platform === "win32" && !fs.existsSync(tar)) {
      reject(new Error(`Windows 系统 tar.exe 不存在: ${tar}`));
      return;
    }
    // 明确调用 System32 的 bsdtar，使用 C:/... 路径，避开 Git GNU tar 的路径转换。
    const toTarPath = (value: string) => process.platform === "win32"
      ? value.replace(/\\/g, "/") : value;
    const args = ["-xzf", toTarPath(file), "-C", toTarPath(dest)];
    const proc = spawn(tar, args, { stdio: "ignore", windowsHide: true });
    proc.on("error", (error) => reject(new Error(`tar extract failed: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract exit ${code}`));
    });
  });
}

/** 兼容官方归档的不同目录布局和 opencode 旧入口名。 */
function findBinary(dir: string, names: string[]): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const name of names) {
    const match = entries.find((entry) => entry.isFile() && entry.name === name);
    if (match) return path.join(dir, name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findBinary(path.join(dir, entry.name), names);
      if (found) return found;
    }
  }
  return null;
}

function binaryVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(binary, ["-v"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    let finished = false;
    const finish = (version: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(version);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, 10000);
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 1000) proc.kill();
    });
    proc.on("error", () => finish(null));
    proc.on("close", (code) => finish(code === 0 ? output.trim().replace(/^v/, "") : null));
  });
}

/** 旧 AppData 缓存没有可信版本标记，不作为 1.17.11 直接复用。 */
async function installedBinaryIsCurrent(platformDir: string, binary: string): Promise<boolean> {
  const marker = path.join(platformDir, ".version");
  const hashFile = path.join(platformDir, ".sha256");
  try {
    if (!fs.existsSync(marker) || !fs.existsSync(hashFile) || !fs.existsSync(binary)) return false;
    if (fs.readFileSync(marker, "utf-8").trim() !== NUWAXCODE_VERSION) return false;
    if (fs.readFileSync(hashFile, "utf-8").trim() !== sha256File(binary)) return false;
    return (await binaryVersion(binary)) === NUWAXCODE_VERSION;
  } catch {
    return false;
  }
}

async function installArchive(
  url: string,
  expectedArchiveHash: string,
  destPlatformDir: string,
  binary: string,
): Promise<string> {
  const tmpRoot = path.join(getAppDataDir(), "tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tmpRoot, "nuwaxcode-install-"));
  const archive = path.join(workDir, "release.tar.gz");
  const extracted = path.join(workDir, "extracted");
  const ready = path.join(workDir, "ready");
  // 备份放在目标同级：若回滚也失败，清理临时目录不会误删旧安装。
  const backup = path.join(
    path.dirname(destPlatformDir),
    `${path.basename(destPlatformDir)}-backup-${path.basename(workDir)}`,
  );

  try {
    await downloadTo(url, archive);
    if (sha256File(archive) !== expectedArchiveHash) {
      throw new Error(`归档 SHA256 与官方 Release digest 不符: ${url}`);
    }
    await extractArchive(archive, extracted);
    const sourceBinary = findBinary(
      extracted,
      binary.endsWith(".exe") ? [binary, "opencode.exe"] : [binary, "opencode"],
    );
    if (!sourceBinary) throw new Error("解压完成但未找到 nuwaxcode 二进制");

    const readyBinDir = path.join(ready, "bin");
    fs.mkdirSync(ready, { recursive: true });
    fs.cpSync(path.dirname(sourceBinary), readyBinDir, { recursive: true });
    const readyBinary = path.join(readyBinDir, binary);
    if (path.basename(sourceBinary) !== binary) {
      fs.copyFileSync(path.join(readyBinDir, path.basename(sourceBinary)), readyBinary);
    }
    const assetsDir = path.join(readyBinDir, "assets");
    const modelJson = path.join(assetsDir, "model.json");
    if (!fs.existsSync(modelJson)) {
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(modelJson, JSON.stringify({
        models: [], source: "generated-fallback", version: NUWAXCODE_VERSION,
      }));
    }
    fs.chmodSync(readyBinary, 0o755);
    const version = await binaryVersion(readyBinary);
    if (version !== NUWAXCODE_VERSION) {
      throw new Error(`下载二进制版本不符: ${version || "无法读取"}，期望 ${NUWAXCODE_VERSION}`);
    }
    fs.writeFileSync(path.join(ready, ".version"), `${NUWAXCODE_VERSION}\n`);
    fs.writeFileSync(path.join(ready, ".sha256"), `${sha256File(readyBinary)}\n`);

    let movedOld = false;
    if (fs.existsSync(destPlatformDir)) {
      fs.renameSync(destPlatformDir, backup);
      movedOld = true;
    }
    try {
      fs.renameSync(ready, destPlatformDir);
    } catch (error) {
      if (movedOld) {
        try { fs.renameSync(backup, destPlatformDir); }
        catch (restoreError) {
          throw new Error(`更新失败且旧版本回滚失败，备份位于 ${backup}: ${String(restoreError)}`);
        }
      }
      throw error;
    }
    if (movedOld) {
      try { fs.rmSync(backup, { recursive: true, force: true }); }
      catch (cleanupError) { log.warn("[NuwaxcodeDeps] old backup cleanup failed:", cleanupError); }
    }
    return path.join(destPlatformDir, "bin", binary);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

let inFlight: Promise<DownloadResult> | null = null;

async function downloadNuwaxcodeImpl(): Promise<DownloadResult> {
  const platform = os.platform() === "win32" ? "windows" : os.platform();
  const key = `${platform}-${os.arch()}`;
  const binary = platform === "windows" ? "nuwaxcode.exe" : "nuwaxcode";
  const destPlatformDir = path.join(getAppDataDir(), "nuwaxcode", key);
  const expectedBin = path.join(destPlatformDir, "bin", binary);

  if (await installedBinaryIsCurrent(destPlatformDir, expectedBin)) {
    log.info("[NuwaxcodeDeps] verified installed:", expectedBin);
    return { success: true, version: NUWAXCODE_VERSION, binPath: expectedBin };
  }

  fs.mkdirSync(path.dirname(destPlatformDir), { recursive: true });
  const releaseName = `nuwaxcode-${key}-v${NUWAXCODE_VERSION}.tar.gz`;
  const githubUrl = `${RELEASE_BASE}/${releaseName}`;
  const releaseHash = RELEASE_SHA256[key];
  if (!releaseHash) {
    return {
      success: false,
      version: NUWAXCODE_VERSION,
      error: `平台 ${key} 没有固定 SHA256 的官方 Release 资产`,
    };
  }

  try {
    log.info(`[NuwaxcodeDeps] downloading ${githubUrl}`);
    const binPath = await installArchive(
      githubUrl, releaseHash, destPlatformDir, binary,
    );
    log.info(`[NuwaxcodeDeps] installed: ${binPath}`);
    return { success: true, version: NUWAXCODE_VERSION, binPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`[NuwaxcodeDeps] install failed: ${reason}`);
    return { success: false, version: NUWAXCODE_VERSION, error: reason };
  }
}

export function downloadNuwaxcode(): Promise<DownloadResult> {
  if (!inFlight) {
    inFlight = downloadNuwaxcodeImpl().finally(() => { inFlight = null; });
  }
  return inFlight;
}
