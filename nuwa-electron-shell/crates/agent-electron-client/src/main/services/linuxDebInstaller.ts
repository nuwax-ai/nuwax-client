/**
 * Linux deb 安装形态的客户端内升级。
 *
 * 授权与安装是同一次 pkexec 调用：密码框由桌面自带的 polkit 授权代理弹出，密码不经过本进程，
 * 也不依赖 zenity 这类外部工具（统信 UOS 不带 zenity，sudo -A 没有它们就直接拒绝）。
 * 与 electron-updater 的 DebUpdater 是同一种提权方式，区别只在它同步调用 —— 等待授权期间主进程冻结；
 * 这里异步执行。
 *
 * 客户端进程不在登录会话里（Chromium 会把自己移进 systemd 用户作用域），本机桌面上 polkit 仍会把
 * 授权框弹到当前活跃的图形会话（统信 UOS 20 Pro 1050 实测）。远程桌面下授权框会出现在物理屏幕上，
 * 这种场景不在支持范围内：用户取消或一直不应答，都不会安装任何东西。
 *
 * pkexec 返回安装命令的退出码；它自己的失败只有两个：用户在授权框点了取消是 126，
 * 拿不到授权或出错是 127（例如桌面上没有授权代理）。
 */

import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** $1 = deb 路径。dpkg 因依赖缺失失败时由 apt-get 补齐依赖并完成配置。 */
export const DEB_INSTALL_SCRIPT =
  'export DEBIAN_FRONTEND=noninteractive; dpkg -i "$1" || apt-get install -f -y';

export type LinuxDebInstallResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "auth-failed" | "install-failed" | "needs-desktop-restart" };

export interface LinuxDebInstallOptions {
  debPath: string;
  /** dpkg 输出追加写入的日志文件 */
  logPath: string;
}

export interface LinuxDebInstallerDeps {
  spawn: (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;
  findCommand: (name: string) => string | null;
  isRoot: () => boolean;
  readProcessStatus: () => string;
  openLog: (logPath: string) => number;
  closeLog: (fd: number) => void;
}

/** pkexec 自身的退出码；安装命令几乎不会以这两个值结束。 */
const PKEXEC_CANCELLED = 126;
const PKEXEC_UNAVAILABLE = 127;

function findCommandInPath(name: string): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续查找下一个 PATH 目录
    }
  }
  return null;
}

function openLogFile(logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "a");
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} deb install =====\n`);
  return fd;
}

const defaultDeps: LinuxDebInstallerDeps = {
  spawn: nodeSpawn,
  findCommand: findCommandInPath,
  isRoot: () => process.getuid?.() === 0,
  readProcessStatus: () => fs.readFileSync("/proc/self/status", "utf8"),
  openLog: openLogFile,
  closeLog: (fd) => fs.closeSync(fd),
};

function hasNoNewPrivileges(readProcessStatus: () => string): boolean {
  try {
    return /^NoNewPrivs:[ \t]*1[ \t]*$/m.test(readProcessStatus());
  } catch {
    return false;
  }
}

/** 进程退出码；无法启动返回 null。 */
function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
}

function failureFor(code: number, viaPkexec: boolean): LinuxDebInstallResult {
  if (viaPkexec && code === PKEXEC_CANCELLED) return { ok: false, reason: "auth-failed" };
  if (viaPkexec && code === PKEXEC_UNAVAILABLE) return { ok: false, reason: "unavailable" };
  return { ok: false, reason: "install-failed" };
}

export async function installLinuxDeb(
  options: LinuxDebInstallOptions,
  deps: LinuxDebInstallerDeps = defaultDeps,
): Promise<LinuxDebInstallResult> {
  const scriptArgs = ["-c", DEB_INSTALL_SCRIPT, "nuwax-update", options.debPath];
  if (deps.isRoot()) {
    return runInstall(deps, options.logPath, "/bin/sh", scriptArgs, false);
  }
  if (hasNoNewPrivileges(deps.readProcessStatus)) {
    return { ok: false, reason: "needs-desktop-restart" };
  }
  const pkexec = deps.findCommand("pkexec");
  if (!pkexec) return { ok: false, reason: "unavailable" };
  // pkexec 只接受绝对路径的程序，并在最小环境里运行它：非交互前端由脚本自己导出。
  return runInstall(deps, options.logPath, pkexec, ["/bin/sh", ...scriptArgs], true);
}

async function runInstall(
  deps: LinuxDebInstallerDeps,
  logPath: string,
  cmd: string,
  args: string[],
  viaPkexec: boolean,
): Promise<LinuxDebInstallResult> {
  const fd = deps.openLog(logPath);
  try {
    // 输出写文件不接管道：壳在安装中途退出时 dpkg 不会因 SIGPIPE 中止。
    const code = await waitForExit(deps.spawn(cmd, args, { stdio: ["ignore", fd, fd] }));
    if (code === 0) return { ok: true };
    // 进程没起来（pkexec 不存在、无权执行）：和拿不到授权一样，只能请用户手动安装。
    return code === null ? { ok: false, reason: "unavailable" } : failureFor(code, viaPkexec);
  } finally {
    deps.closeLog(fd);
  }
}
