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
});
