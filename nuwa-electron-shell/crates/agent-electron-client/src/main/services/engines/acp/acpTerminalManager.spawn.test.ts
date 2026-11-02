import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const mockSpawn = vi.fn();
const mockGetBundledGitBashPath = vi.fn(() => "");

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@main/services/system/binaryLocator", () => ({
  getBundledGitBashPath: () => mockGetBundledGitBashPath(),
}));

vi.mock("@main/services/system/platformAdapter", () => ({
  createPlatformAdapter: vi.fn(() => ({
    isWindows: true,
    platform: "win32",
  })),
}));

vi.mock("@main/services/utils/processTree", () => ({
  killProcessTree: vi.fn(),
}));

import { AcpTerminalManager } from "./acpTerminalManager";

function mockChildProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.pid = 4242;
  proc.kill = vi.fn();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("AcpTerminalManager direct spawn (Windows)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    mockSpawn.mockReset();
    mockGetBundledGitBashPath.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("retains output limits, exit status and session ownership without a helper process", async () => {
    const child = mockChildProcess();
    mockSpawn.mockReturnValue(child);
    const manager = new AcpTerminalManager();
    const id = await manager.createTerminal({
      sessionId: "owner",
      command: "echo",
      outputByteLimit: 4,
    });
    child.stdout.emit("data", Buffer.from("abcdef"));
    const output = await manager.terminalOutput(id, "owner");
    expect(output).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(4);
    await expect(manager.terminalOutput(id, "other-session")).rejects.toThrow(
      /does not belong/,
    );
    child.emit("close", 7, null);
    await expect(manager.waitForExit(id, "owner")).resolves.toEqual({
      exitCode: 7,
      signal: null,
    });
    await manager.release(id, "owner");
    await expect(manager.terminalOutput(id, "owner")).rejects.toThrow(
      /not found/,
    );
  });

  it("uses Git Bash -c when bundled bash is available", async () => {
    const bash = "C:\\app\\resources\\git\\bin\\bash.exe";
    mockGetBundledGitBashPath.mockReturnValue(bash);
    mockSpawn.mockReturnValue(mockChildProcess());

    const manager = new AcpTerminalManager();
    await manager.createTerminal({
      sessionId: "ses-1",
      command: "./scripts/run.sh",
      args: [],
      cwd: "C:\\workspace",
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe(bash);
    expect(args).toEqual(["-c", "./scripts/run.sh"]);
    expect(options.shell).toBe(false);
  });

  it("falls back to cmd shell when bundled bash is missing", async () => {
    mockGetBundledGitBashPath.mockReturnValue("");
    mockSpawn.mockReturnValue(mockChildProcess());

    const manager = new AcpTerminalManager();
    await manager.createTerminal({
      sessionId: "ses-2",
      command: "npm",
      args: ["test"],
      cwd: "C:\\workspace",
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe("npm");
    expect(args).toEqual(["test"]);
    expect(options.shell).toBe(true);
  });
});
