import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkWindowsInstallRuntime } from "./windowsInstallPreflight";

const { execute, exists } = vi.hoisted(() => ({ execute: vi.fn(), exists: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execute }));
vi.mock("node:fs", () => ({ existsSync: exists }));

describe("Windows installation runtime preflight", () => {
  beforeEach(() => {
    exists.mockReset().mockReturnValue(true);
    execute.mockReset().mockImplementation((_file, _args, _options, done) => done(null, "NUWAX_INSTALL_RUNTIME_OK\r\n", ""));
  });

  it("checks the same x86 PowerShell as NSIS with bounded, shell-free execution", async () => {
    await checkWindowsInstallRuntime("C:\\Program Files\\Nuwax\\resources", "C:\\Windows");
    expect(execute).toHaveBeenCalledWith(
      "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\Program Files\\Nuwax\\resources\\installer\\installer-runtime.ps1"],
      expect.objectContaining({ windowsHide: true, timeout: 35_000, cwd: "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0" }),
      expect.any(Function),
    );
    expect(execute.mock.calls[0][2].shell).toBeUndefined();
  });

  it("falls back to System32 when the x86 host is unavailable", async () => {
    exists.mockImplementation((name: string) => !name.includes("SysWOW64"));
    await checkWindowsInstallRuntime("C:\\app\\resources", "C:\\Windows");
    expect(execute.mock.calls[0][0]).toContain("\\System32\\");
  });

  it("rejects missing resources without spawning a process", async () => {
    exists.mockReturnValue(false);
    await expect(checkWindowsInstallRuntime("C:\\app\\resources", "C:\\Windows")).rejects.toThrow("missing");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("timed out"), "", "", "timed out"],
    [new Error("exit 2"), "", "Application control blocked Add-Type", "Application control blocked Add-Type"],
    [null, "", "", "No success receipt"],
    [new Error("exit 2"), "NUWAX_INSTALL_RUNTIME_OK", "", "exit 2"],
  ])("requires both a successful process and an explicit receipt", async (error, stdout, stderr, message) => {
    execute.mockImplementation((_file, _args, _options, done) => done(error, stdout, stderr));
    await expect(checkWindowsInstallRuntime("C:\\app\\resources", "C:\\Windows")).rejects.toThrow(String(message));
  });
});
