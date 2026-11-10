import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type CuaDriverTransport = Pick<ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "exitCode" | "signalCode" | "kill"> & Pick<EventEmitter, "on" | "once">;

/** In-process adapters use the same bounded RPC and lease teardown as native helpers. */
export class CuaAdapterTransport extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private input = "";
  private lifetime = new AbortController();
  constructor(private handle: (message: Record<string, any>, signal: AbortSignal) => Promise<unknown>, private dispose: () => Promise<void>) {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      this.input += chunk.toString("utf8");
      if (Buffer.byteLength(this.input) > 1024 * 1024) { this.kill(); done(); return; }
      while (this.input.includes("\n")) {
        const end = this.input.indexOf("\n"), line = this.input.slice(0, end);
        this.input = this.input.slice(end + 1);
        let message: Record<string, any>;
        try { message = JSON.parse(line); } catch { this.kill(); break; }
        void this.handle(message, this.lifetime.signal).then(result => {
          if (message.id !== undefined && !this.lifetime.signal.aborted)
            this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        }).catch(() => {
          if (message.id !== undefined && !this.lifetime.signal.aborted)
            this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Computer Use adapter failed" } }) + "\n");
        });
      }
      done();
    } });
  }
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.lifetime.signal.aborted) return true;
    this.lifetime.abort();
    const finish = (code: number) => {
      this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
      this.exitCode = code; this.stdout.end(); this.stderr.end(); this.emit("exit", code, this.signalCode);
    };
    void this.dispose().then(() => finish(0), () => finish(1));
    return true;
  }
}
