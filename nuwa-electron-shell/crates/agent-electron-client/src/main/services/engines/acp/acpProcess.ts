import { spawn, type ChildProcess } from "child_process";
import { once } from "node:events";
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
export async function spawnAcpProcess(options: AcpProcessOptions): Promise<ChildProcess> {
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    detached: options.detached,
  };
  const proc = options.isNative
    ? spawn(options.binPath, options.args, {
        ...spawnOptions,
        windowsHide: true,
      })
    : spawnJsFile(options.binPath, options.args, spawnOptions);
  // Use the OS spawn error before the ACP handshake can mask it with a pipe error.
  await once(proc, "spawn");
  return proc;
}
