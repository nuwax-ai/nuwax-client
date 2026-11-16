import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Run before shutdown; never invoke an unknown installer's command-line switches. */
export async function checkWindowsInstallRuntime(
  resourcesPath: string,
  systemRoot = process.env.SystemRoot ?? process.env.windir,
): Promise<void> {
  if (!systemRoot) throw new Error("Windows system directory is unavailable.");
  const relative = "WindowsPowerShell\\v1.0\\powershell.exe";
  // Builder's NSIS is x86, so use the same runtime even from the x64 application.
  const x86 = path.win32.join(systemRoot, "SysWOW64", relative);
  const executable = existsSync(x86) ? x86 : path.win32.join(systemRoot, "System32", relative);
  const script = path.win32.join(resourcesPath, "installer", "installer-runtime.ps1");
  if (!existsSync(executable) || !existsSync(script)) {
    throw new Error("Windows PowerShell or the installer runtime check is missing.");
  }
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true, timeout: 35_000, maxBuffer: 256 * 1024,
      encoding: "utf8", cwd: path.win32.dirname(executable),
    }, (error, stdout, stderr) => {
      if (error || stdout.trim() !== "NUWAX_INSTALL_RUNTIME_OK") {
        reject(new Error(`Windows installer preflight failed: ${stderr.trim() || error?.message || stdout.trim() || "No success receipt"}`));
      } else {
        resolve();
      }
    });
  });
}
