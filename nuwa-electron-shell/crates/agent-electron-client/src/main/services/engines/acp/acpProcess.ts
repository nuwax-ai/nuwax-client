import { spawn, type ChildProcess } from "child_process";
import { spawnJsFile } from "../../utils/spawnNoWindow";

export interface AcpProcessOptions {
  binPath: string;
  args: string[];
  isNative: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
}

/** Native executables run directly; JavaScript adapters use the bundled Node launcher. */
export function spawnAcpProcess(options: AcpProcessOptions): ChildProcess {
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    detached: options.detached,
  };
  return options.isNative
    ? spawn(options.binPath, options.args, {
        ...spawnOptions,
        windowsHide: true,
      })
    : spawnJsFile(options.binPath, options.args, spawnOptions);
}
