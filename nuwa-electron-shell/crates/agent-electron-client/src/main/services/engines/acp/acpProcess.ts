import { spawn, type ChildProcess } from "child_process";
import { once } from "node:events";
import { spawnJsFile } from "../../utils/spawnNoWindow";
import { setupTimeoutMessage } from "./acpSetupBudgets";

export interface AcpProcessOptions {
  binPath: string;
  args: string[];
  isNative: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  /** 等待 spawn 事件的上限（ms）；到点杀掉子进程并抛错。缺省不限时。 */
  spawnTimeoutMs?: number;
}

/**
 * 等 spawn 事件。带时限时到点强杀并抛错：引擎进程起不来时，init 不能跟着永久挂起
 * （会话建立阶段的预算见 acpSetupBudgets）。报错措辞用 setupTimeoutMessage，
 * 上游据此把初始化超时映射成明确的失败原因。
 */
async function waitForSpawn(
  proc: ChildProcess,
  timeoutMs: number | undefined,
): Promise<void> {
  if (!timeoutMs || timeoutMs <= 0) {
    await once(proc, "spawn");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          // 已退出
        }
        reject(new Error(setupTimeoutMessage("engine spawn", timeoutMs)));
      },
      timeoutMs,
    );
    proc.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    proc.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
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
  await waitForSpawn(proc, options.spawnTimeoutMs);
  return proc;
}
