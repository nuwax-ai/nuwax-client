import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DesktopEnvelope = { ok: boolean; data?: any; error?: { code?: string; disposition?: { delivery?: string; retry?: string } } };
export type DesktopRunOptions = { home: string; signal?: AbortSignal; input?: string };
export type DesktopRun = (args: string[], options: DesktopRunOptions) => Promise<DesktopEnvelope>;

/** Kill only the process group/tree created by this invocation, including native helper children. */
export function createDesktopRunner(executable: string, environment: () => Record<string, string>, validate?: () => Promise<void>): DesktopRun {
  return async (args, options) => {
    await validate?.();
    fs.mkdirSync(options.home, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...environment(), AGENT_DESKTOP_HOME: options.home };
    for (const key of ["AGENT_DESKTOP_SESSION", "AGENT_DESKTOP_AGENT_ID", "AGENT_DESKTOP_TRACE", "AGENT_DESKTOP_HEADED"]) delete env[key];
    if (process.platform === "darwin") env.AGENT_DESKTOP_MACOS_HELPER_PATH = path.join(path.dirname(executable), `agent-desktop-macos-helper-darwin-${process.arch}`);
    return new Promise<DesktopEnvelope>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error("operationCancelled")); return; }
      const child = spawn(executable, args, { env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", settled = false, timedOut = false;
      const killTree = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { env, windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill());
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
        }
      };
      const abort = () => killTree();
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; killTree(); }, 15_000);
      const finish = (error?: Error, code?: number | null) => {
        if (settled) return; settled = true;
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        if (error || timedOut || options.signal?.aborted) { reject(error ?? new Error(timedOut ? "toolTimeout" : "operationCancelled")); return; }
        try {
          const result = JSON.parse(stdout);
          if (typeof result.ok !== "boolean") throw new Error("helperProtocolInvalid");
          if (result.ok && code !== 0) throw new Error("helperProtocolInvalid");
          resolve(result);
        } catch { reject(new Error("helperProtocolInvalid")); }
      };
      child.on("error", error => finish(error));
      child.stdout.on("data", chunk => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) { timedOut = true; killTree(); }
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("close", code => finish(undefined, code));
      child.stdin.end(options.input);
      if (options.signal?.aborted) abort();
    });
  };
}
