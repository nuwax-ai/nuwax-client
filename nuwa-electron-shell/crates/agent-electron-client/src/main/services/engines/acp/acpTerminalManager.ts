/** ACP terminal transport with owned process cleanup and bounded output. */

import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import log from "electron-log";
import { killProcessTree } from "@main/services/utils/processTree";
import { createPlatformAdapter } from "@main/services/system/platformAdapter";
import { wrapWindowsCommandWithGitBash } from "@main/services/system/windowsGitBashCommand";

// ============================================================================
// Types
// ============================================================================

interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface TerminalSession {
  id: string;
  sessionId: string;
  /** Running child process (null after exit) */
  process: ChildProcess | null;
  /** Accumulated stdout + stderr output */
  output: string;
  /** Max output bytes to retain (null = unlimited) */
  byteLimit: number | null;
  /** Whether output was truncated due to byteLimit */
  truncated: boolean;
  /** Exit status (null while running) */
  exitStatus: TerminalExitStatus | null;
  /** Whether waitForExit promise has resolved */
  resolved: boolean;
  /** Promise that resolves when the process exits */
  exitPromise: Promise<TerminalExitStatus>;
  /** Resolver for exitPromise */
  resolveExit: (status: TerminalExitStatus) => void;
}

// ============================================================================
// AcpTerminalManager
// ============================================================================

export class AcpTerminalManager {
  private static readonly MAX_CONCURRENT = 50;
  private terminals = new Map<string, TerminalSession>();
  // --- terminal/create ---

  async createTerminal(params: {
    sessionId: string;
    command: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    cwd?: string | null;
    outputByteLimit?: number | null;
  }): Promise<string> {
    if (this.terminals.size >= AcpTerminalManager.MAX_CONCURRENT) {
      throw new Error(
        `Terminal limit reached (${AcpTerminalManager.MAX_CONCURRENT}). Release existing terminals first.`,
      );
    }

    const terminalId = `term_${randomUUID()}`;

    let resolveExit: ((status: TerminalExitStatus) => void) | null = null;
    const exitPromise = new Promise<TerminalExitStatus>((r) => {
      resolveExit = r;
    });

    const session: TerminalSession = {
      id: terminalId,
      sessionId: params.sessionId,
      process: null,
      output: "",
      byteLimit: params.outputByteLimit ?? null,
      truncated: false,
      exitStatus: null,
      resolved: false,
      exitPromise,
      resolveExit: resolveExit!,
    };

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(params.env
        ? Object.fromEntries(params.env.map(({ name, value }) => [name, value]))
        : {}),
    };
    const cwd = params.cwd ?? process.cwd();

    // Register BEFORE spawning so fast-exiting processes don't cause "not found" errors
    // in terminalOutput()/waitForExit() calls from the agent.
    this.terminals.set(terminalId, session);

    const directCommand = wrapWindowsCommandWithGitBash(
      params.command,
      params.args || [],
    );
    log.info("[AcpTerminalManager] ⚡ Terminal created:", {
      terminalId,
      sessionId: params.sessionId,
      originalCommand: params.command,
      originalArgs: params.args,
      command: directCommand.command,
      args: directCommand.args,
      platform: createPlatformAdapter().platform,
      cwd,
    });

    try {
      this.spawnProcess(
        session,
        directCommand.command,
        directCommand.args,
        env,
        cwd,
        !directCommand.gitBashWrapped,
      );
    } catch (spawnErr) {
      this.cleanupFailedSpawn(session, terminalId);
      throw spawnErr;
    }

    return terminalId;
  }

  // --- terminal/output ---

  async terminalOutput(
    terminalId: string,
    sessionId?: string,
  ): Promise<{
    output: string;
    truncated: boolean;
    exitStatus: TerminalExitStatus | null;
  }> {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`Terminal not found: ${terminalId}`);
    if (sessionId && t.sessionId !== sessionId) {
      throw new Error(
        `Terminal ${terminalId} does not belong to session ${sessionId}`,
      );
    }
    return {
      output: t.output,
      truncated: t.truncated,
      exitStatus: t.exitStatus,
    };
  }

  // --- terminal/wait_for_exit ---

  async waitForExit(
    terminalId: string,
    sessionId?: string,
  ): Promise<TerminalExitStatus> {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`Terminal not found: ${terminalId}`);
    if (sessionId && t.sessionId !== sessionId) {
      throw new Error(
        `Terminal ${terminalId} does not belong to session ${sessionId}`,
      );
    }
    return t.exitPromise;
  }

  // --- terminal/kill ---

  async kill(terminalId: string, sessionId?: string): Promise<void> {
    const t = this.terminals.get(terminalId);
    if (!t || !t.process) return;
    if (sessionId && t.sessionId !== sessionId) {
      throw new Error(
        `Terminal ${terminalId} does not belong to session ${sessionId}`,
      );
    }
    log.info("[AcpTerminalManager] Killing terminal:", terminalId);
    try {
      const pid = t.process.pid;
      if (pid) {
        await killProcessTree(pid, "SIGKILL");
      } else {
        t.process.kill("SIGKILL");
      }
    } catch {
      // Process may have already exited
    }
    // Safety-net: resolve exitPromise in case the 'close' event is lost
    // after killProcessTree (possible on Windows where process tree kill
    // can race with the Node.js event loop).
    if (!t.resolved) {
      t.resolved = true;
      t.resolveExit({ exitCode: null, signal: "SIGKILL" });
    }
  }

  // --- terminal/release ---

  async release(terminalId: string, sessionId?: string): Promise<void> {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    if (sessionId && t.sessionId !== sessionId) {
      throw new Error(
        `Terminal ${terminalId} does not belong to session ${sessionId}`,
      );
    }
    log.info("[AcpTerminalManager] Releasing terminal:", terminalId);
    if (t.process) {
      try {
        const pid = t.process.pid;
        if (pid) {
          await killProcessTree(pid, "SIGKILL");
        } else {
          t.process.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
    }
    // Resolve exitPromise if still pending so waitForExit() doesn't hang
    if (!t.resolved) {
      t.resolved = true;
      t.resolveExit({ exitCode: null, signal: null });
    }
    this.terminals.delete(terminalId);
  }

  /** Release all terminals belonging to a specific session */
  async releaseForSession(sessionId: string): Promise<void> {
    const ids: string[] = [];
    for (const [id, t] of this.terminals) {
      if (t.sessionId === sessionId) {
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      log.info(
        `[AcpTerminalManager] Releasing ${ids.length} terminals for session ${sessionId}`,
      );
    }
    for (const id of ids) {
      await this.release(id);
    }
  }

  /** Release all terminals (called during engine destroy) */
  async releaseAll(): Promise<void> {
    const ids = Array.from(this.terminals.keys());
    if (ids.length > 0) {
      log.info(`[AcpTerminalManager] Releasing ${ids.length} terminals`);
    }
    for (const id of ids) {
      await this.release(id);
    }
  }

  /**
   * Returns the ACP Client handler methods for terminal/* operations.
   *
   * Spread into `buildClientHandler()` return value:
   * ```ts
   * return { ...existingHandlers, ...this.terminalManager.getClientHandlers() };
   * ```
   */
  getClientHandlers(): Pick<
    import("./acpClient").AcpClientHandler,
    | "createTerminal"
    | "terminalOutput"
    | "waitForTerminalExit"
    | "killTerminal"
    | "releaseTerminal"
  > {
    return {
      createTerminal: async (params) => {
        const terminalId = await this.createTerminal(params);
        return { terminalId };
      },

      terminalOutput: async (params) => {
        return this.terminalOutput(params.terminalId, params.sessionId);
      },

      waitForTerminalExit: async (params) => {
        return this.waitForExit(params.terminalId, params.sessionId);
      },

      killTerminal: async (params) => {
        await this.kill(params.terminalId, params.sessionId);
        return {};
      },

      releaseTerminal: async (params) => {
        await this.release(params.terminalId, params.sessionId);
        return {};
      },
    };
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private spawnProcess(
    session: TerminalSession,
    command: string,
    args: string[],
    env: Record<string, string> | undefined,
    cwd: string,
    /** bundled Git Bash 不可用时，Windows 直连终端回退 cmd shell */
    useWindowsCmdShellFallback = false,
  ): void {
    const platformAdapter = createPlatformAdapter();
    const useShell = platformAdapter.isWindows && useWindowsCmdShellFallback;
    log.info("[AcpTerminalManager] 🚀 Spawning process:", {
      terminalId: session.id,
      command,
      args: args.length > 0 ? args : undefined,
      cwd,
      shell: useShell,
    });

    const proc = spawn(command, args, {
      cwd,
      env,
      shell: useShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], // stdin not wired — non-interactive commands only
    });
    session.process = proc;

    log.info("[AcpTerminalManager] Process spawned:", {
      terminalId: session.id,
      pid: proc.pid,
    });

    // Direct execution: stdout/stderr are command output
    proc.stdout?.on("data", (data: Buffer) => this.appendOutput(session, data));
    proc.stderr?.on("data", (data: Buffer) => this.appendOutput(session, data));
    proc.on("close", (code, signal) => {
      log.info("[AcpTerminalManager] 🔚 Direct process exited:", {
        terminalId: session.id,
        exitCode: code,
        signal,
        outputLength: session.output.length,
      });
      const status: TerminalExitStatus = {
        exitCode: code,
        signal: signal ?? null,
      };
      session.exitStatus = status;
      session.process = null;
      if (!session.resolved) {
        session.resolved = true;
        session.resolveExit(status);
      }
    });

    proc.on("error", (err) => {
      log.error("[AcpTerminalManager] Process spawn error:", err);
      const status: TerminalExitStatus = { exitCode: 1, signal: null };
      session.exitStatus = status;
      session.process = null;
      if (!session.resolved) {
        session.resolved = true;
        session.resolveExit(status);
      }
    });
  }

  /**
   * Clean up a terminal session when spawn() throws synchronously.
   * Resolves the exitPromise and removes the session from the map
   * to prevent resource leaks.
   */
  private cleanupFailedSpawn(
    session: TerminalSession,
    terminalId: string,
  ): void {
    log.warn(
      "[AcpTerminalManager] Spawn failed, cleaning up terminal:",
      terminalId,
    );
    const status: TerminalExitStatus = { exitCode: 1, signal: null };
    session.exitStatus = status;
    session.process = null;
    if (!session.resolved) {
      session.resolved = true;
      session.resolveExit(status);
    }
    this.terminals.delete(terminalId);
  }

  private appendOutput(session: TerminalSession, data: Buffer): void {
    const text = data.toString();
    session.output += text;
    if (session.byteLimit && session.output.length > session.byteLimit) {
      // Truncate from the beginning, preserving the most recent output
      session.output = session.output.slice(
        session.output.length - session.byteLimit,
      );
      session.truncated = true;
    }
  }
}
