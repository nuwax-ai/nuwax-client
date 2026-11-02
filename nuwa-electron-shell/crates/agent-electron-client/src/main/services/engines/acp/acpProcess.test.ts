import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { spawnJsFile } from "../../utils/spawnNoWindow";
import { spawnAcpProcess } from "./acpProcess";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../utils/spawnNoWindow", () => ({ spawnJsFile: vi.fn() }));

describe("ACP process transport", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([true, false])(
    "starts the expected transport for native=%s",
    (isNative) => {
      const process = { pid: 123 };
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
      expect(spawnAcpProcess(options)).toBe(process);
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
});
