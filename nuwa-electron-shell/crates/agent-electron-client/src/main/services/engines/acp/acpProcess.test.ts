import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { EventEmitter } from "node:events";
import { spawnJsFile } from "../../utils/spawnNoWindow";
import { spawnAcpProcess } from "./acpProcess";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../utils/spawnNoWindow", () => ({ spawnJsFile: vi.fn() }));

describe("ACP process transport", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([true, false])(
    "starts the expected transport for native=%s",
    async (isNative) => {
      const process = new EventEmitter();
      vi.mocked(spawn).mockReturnValue(process as never);
      vi.mocked(spawnJsFile).mockReturnValue(process as never);
      const options = {
        binPath: isNative ? "/tools/nuwaxcode" : "/tools/adapter.mjs",
        args: ["acp"],
        isNative,
        cwd: "/project",
        env: { PATH: "/tools" },
        detached: true,
      };
      const started = vi.fn();
      const launch = spawnAcpProcess(options).then(started);
      await Promise.resolve();
      expect(started).not.toHaveBeenCalled();
      process.emit("spawn");
      await launch;
      expect(started).toHaveBeenCalledWith(process);
      const selected = isNative ? vi.mocked(spawn) : vi.mocked(spawnJsFile);
      expect(selected).toHaveBeenCalledWith(options.binPath, options.args, {
        cwd: "/project",
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        ...(isNative ? { windowsHide: true } : {}),
      });
      expect(isNative ? spawnJsFile : spawn).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "preserves the launch error before establishing stdio, native=%s",
    async (isNative) => {
      const process = new EventEmitter();
      vi.mocked(spawn).mockReturnValue(process as never);
      vi.mocked(spawnJsFile).mockReturnValue(process as never);
      const error = Object.assign(new Error("spawn /tools/adapter ENOENT"), { code: "ENOENT" });
      const result = spawnAcpProcess({
        binPath: "/tools/adapter",
        args: [],
        isNative,
        cwd: "/project",
        env: {},
        detached: false,
      });
      const rejected = expect(result).rejects.toBe(error);
      process.emit("error", error);
      await rejected;
    },
  );

  it("kills the process and rejects when spawn does not happen within the budget", async () => {
    vi.useFakeTimers();
    try {
      const process = Object.assign(new EventEmitter(), {
        kill: vi.fn(),
      });
      vi.mocked(spawn).mockReturnValue(process as never);
      const launch = spawnAcpProcess({
        binPath: "/tools/nuwaxcode",
        args: ["acp"],
        isNative: true,
        cwd: "/project",
        env: {},
        detached: false,
        spawnTimeoutMs: 10_000,
      });
      const rejected = expect(launch).rejects.toThrow(
        "engine spawn timed out after 10000ms",
      );
      await vi.advanceTimersByTimeAsync(9_999);
      expect(process.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still starts when spawn arrives just before the budget runs out", async () => {
    vi.useFakeTimers();
    try {
      const process = Object.assign(new EventEmitter(), {
        kill: vi.fn(),
      });
      vi.mocked(spawn).mockReturnValue(process as never);
      const launch = spawnAcpProcess({
        binPath: "/tools/nuwaxcode",
        args: ["acp"],
        isNative: true,
        cwd: "/project",
        env: {},
        detached: false,
        spawnTimeoutMs: 10_000,
      });
      await vi.advanceTimersByTimeAsync(9_000);
      process.emit("spawn");
      await expect(launch).resolves.toBe(process);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
