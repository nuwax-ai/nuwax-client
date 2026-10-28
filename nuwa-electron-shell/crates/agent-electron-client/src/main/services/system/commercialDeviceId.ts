import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import log from "electron-log";
import { APP_DATA_DIR_NAME } from "@shared/constants";

const DEVICE_SALT = "nuwax:device:v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMAND_OPTIONS = {
  encoding: "utf8" as const,
  timeout: 5_000,
  windowsHide: true,
  maxBuffer: 1024 * 1024,
};

function normalizedId(value: string, allowMachineId = false): string {
  const id = value.trim().toLowerCase();
  const compact = id.replace(/-/g, "");
  if (
    !(UUID_PATTERN.test(id) || (allowMachineId && /^[0-9a-f]{32}$/.test(id))) ||
    /^0{32}$/.test(compact) || /^f{32}$/.test(compact)
  ) throw new Error("Machine identity is missing or invalid");
  return id;
}

function windowsSystemPath(...segments: string[]): string {
  // 32 位进程通过 Sysnative 访问 64 位系统工具，不依赖 PATH 中同名程序。
  const systemDir = process.arch === "ia32" && process.env.PROCESSOR_ARCHITEW6432
    ? "Sysnative" : "System32";
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", systemDir, ...segments);
}

function readHardwareId(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin": {
      const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], COMMAND_OPTIONS);
      return normalizedId(output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || "");
    }
    case "win32":
      return normalizedId(execFileSync(
        windowsSystemPath("WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command",
          "$ErrorActionPreference = 'Stop'; (Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID"],
        COMMAND_OPTIONS,
      ));
    case "linux":
      return normalizedId(readFileSync("/sys/class/dmi/id/product_uuid", "utf8"));
    default:
      throw new Error("Unsupported hardware identity platform");
  }
}

function readInstallationId(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const output = execFileSync(windowsSystemPath("reg.exe"), [
      "QUERY", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid",
    ], COMMAND_OPTIONS);
    return normalizedId(output.match(/REG_SZ\s+([0-9a-f-]+)/i)?.[1] || "");
  }
  if (platform === "linux") {
    for (const file of ["/var/lib/dbus/machine-id", "/etc/machine-id"]) {
      try { return normalizedId(readFileSync(file, "utf8"), true); }
      catch { /* 尝试下一个系统 ID；不采用 hostname 作为设备身份。 */ }
    }
  }
  throw new Error("No valid installation identity");
}

function readPinnedId(file: string): string | null {
  try {
    const id = readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Stored device identity is invalid");
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // 文件损坏/不可读不能悄悄换身份，否则服务端会重复创建电脑。
    throw error;
  }
}

/** 登录凭据之外固定保存首次选定的哈希，防止临时硬件读取失败改变身份。 */
export function getCommercialDeviceId(): string {
  const file = path.join(os.homedir(), APP_DATA_DIR_NAME, "device-id");
  const pinned = readPinnedId(file);
  if (pinned) return pinned;

  const platform = os.platform();
  let raw: string;
  let source = "hardware";
  try { raw = readHardwareId(platform); }
  catch {
    source = "installation";
    try { raw = readInstallationId(platform); }
    catch { raw = randomUUID(); source = "persistent-fallback"; }
    log.warn(`[DeviceId] Hardware identity unavailable; pinning ${source} identity`);
  }
  const id = createHash("sha256").update(raw + DEVICE_SALT).digest("hex");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, id + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // 其他进程先固定了身份，则统一使用它，不能各自注册不同编码。
    const winner = readPinnedId(file);
    if (!winner) throw new Error("Device identity disappeared during creation");
    return winner;
  }
  log.info(`[DeviceId] Pinned ${source} identity`);
  return id;
}
