/**
 * Computer Use control-layer benchmark harness.
 *
 * Runs the product gateway + task controller in-process against a real Nuwax Computer Use
 * daemon, and drives them with a deterministic programmatic agent. The same agent runs
 * against the old and the new control layer, so differences come from the control layer.
 *
 * Usage (from repo root, after the helper daemon is running — see README.md):
 *   node scripts/computer-use/bench/run.mjs [--tasks N1,W1] [--label baseline]
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { CuaMcpGateway } from "../../../overlay/crates/agent-electron-client/src/main/services/cua/mcpGateway";
import { CuaTaskController } from "../../../overlay/crates/agent-electron-client/src/main/services/cua/taskController";
import { cuaPolicy, scopeCuaCall, visibleCuaTools } from "../../../overlay/crates/agent-electron-client/src/main/services/cua/windowScope";
import { TASKS, type BenchContext } from "./tasks";

type Daemon = { socketPath: string; tokenFile: string; dataHome: string; bin: string };
type Rpc = { id?: unknown; result?: { isError?: boolean; structuredContent?: any; content?: Array<{ type: string; text?: string }> }; error?: unknown };

export type CallKind = "ok" | "refused" | "error" | "gateway" | "timeout";
export interface CallResult { kind: CallKind; code?: string; sc: any; text: string; raw: Rpc }

export class TaskAborted extends Error {}

/** Allowed/denied tool lists live in computerUse.ts (which imports electron); read them as text. */
function toolLists(root: string) {
  const src = fs.readFileSync(path.join(root, "overlay/crates/agent-electron-client/src/main/services/cua/computerUse.ts"), "utf8");
  const grab = (name: string) => {
    const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
    if (!m) throw new Error(`cannot read ${name}`);
    return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  };
  return { allowed: grab("CUA_ALLOWED_TOOLS"), denied: grab("CUA_DENIED_TOOLS") };
}

/** Harness-side classification, independent of the control layer under test. */
export function classify(reply: Rpc | null): CallResult {
  if (!reply) return { kind: "timeout", sc: null, text: "", raw: {} };
  const sc = reply.result?.structuredContent ?? null;
  const text = (reply.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (reply.error) return { kind: "gateway", code: String((reply.error as any)?.message ?? "rpcError"), sc, text, raw: reply };
  if (text.startsWith("Computer Use:")) return { kind: "gateway", code: sc?.code ?? text.slice(14).split(".")[0], sc, text, raw: reply };
  const refused = sc && (sc.status === "refused" || sc.effect === "refused" || sc.refusal);
  if (refused) return { kind: "refused", code: sc.refusal?.code ?? sc.code ?? sc.escalation?.reason, sc, text, raw: reply };
  if (reply.result?.isError) return { kind: "error", code: sc?.code, sc, text, raw: reply };
  return { kind: "ok", sc, text, raw: reply };
}

export interface TaskMetrics {
  task: string; success: boolean; abortedReason?: string; detail?: string;
  agentCalls: number; controllerSteps: number; driverRefused: number; driverErrors: number;
  gatewayRejects: Record<string, number>; pauses: string[]; interventions: number; ms: number;
}

class AgentClient {
  private socket!: net.Socket;
  private buffer = "";
  private waiters = new Map<number, (r: Rpc | null) => void>();
  private nextId = 1;
  constructor(private socketPath: string, private token: string) {}
  async connect() {
    this.socket = net.connect(this.socketPath);
    await new Promise<void>((resolve, reject) => { this.socket.once("connect", () => resolve()); this.socket.once("error", reject); });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n"); this.buffer = lines.pop()!;
      for (const line of lines) {
        let m: Rpc; try { m = JSON.parse(line); } catch { continue; }
        const w = this.waiters.get(m.id as number);
        if (w) { this.waiters.delete(m.id as number); w(m); }
      }
    });
    this.socket.on("close", () => { for (const w of this.waiters.values()) w(null); this.waiters.clear(); });
    this.socket.write(JSON.stringify({ token: this.token }) + "\n");
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "1" } });
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  rpc(method: string, params: unknown, timeoutMs = 90_000): Promise<Rpc | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.waiters.delete(id)) resolve(null); }, timeoutMs).unref();
    });
  }
  close() { this.socket?.destroy(); }
}

async function runTask(root: string, daemon: Daemon, lists: { allowed: string[] }, name: string): Promise<TaskMetrics> {
  const controller = new CuaTaskController();
  controller.setAvailable(true);
  const pauses: string[] = [];
  let finished = false;
  let gateway!: CuaMcpGateway;
  const onFailure = (reason: string) => {
    if (finished) return; // closing the harness connection is not a task event
    pauses.push(reason);
    if (controller.snapshot().phase === "running") controller.pause(reason);
    gateway.cancelPending(reason);
    gateway.pauseTransports();
  };
  const desktop = { kind: "desktop" as const };
  const env = { ...process.env, CUA_DRIVER_NUWAX_TOKEN_FILE: daemon.tokenFile, CUA_DRIVER_DATA_HOME: daemon.dataHome, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" };
  gateway = new CuaMcpGateway({
    controller,
    allowedTools: lists.allowed,
    visibleTools: () => visibleCuaTools(desktop, lists.allowed),
    transformCall: (tool, args) => scopeCuaCall(desktop, tool, args),
    launch: () => spawn(daemon.bin, ["mcp", "--socket", daemon.socketPath], { env, stdio: ["pipe", "pipe", "pipe"] }) as any,
    onFailure,
  } as any);
  const gwDir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-gw-"));
  const gwSocket = path.join(gwDir, "g");
  const token = randomBytes(32).toString("hex");
  await gateway.listen(gwSocket, token);
  const client = new AgentClient(gwSocket, token);
  await client.connect();

  const m: TaskMetrics = { task: name, success: false, agentCalls: 0, controllerSteps: 0, driverRefused: 0, driverErrors: 0,
    gatewayRejects: {}, pauses, interventions: 0, ms: 0 };
  const started = Date.now();

  /** Simulated user pressing "resume" in the control bar. */
  const intervene = async () => {
    const st = controller.snapshot();
    if (st.phase !== "paused") throw new TaskAborted(`${st.phase}:${st.reason}`);
    m.interventions++;
    await gateway.resumeTransports();
    if (!controller.resume()) throw new TaskAborted(`cannotResume:${st.reason}`);
  };

  const ctx: BenchContext = {
    root,
    async call(tool, args = {}) {
      m.agentCalls++;
      const res = classify(await client.rpc("tools/call", { name: tool, arguments: args }));
      if (res.kind === "refused") m.driverRefused++;
      if (res.kind === "error") m.driverErrors++;
      if (res.kind === "gateway") m.gatewayRejects[res.code ?? "?"] = (m.gatewayRejects[res.code ?? "?"] ?? 0) + 1;
      const phase = controller.snapshot().phase;
      if (phase === "paused") await intervene();
      else if (phase === "stopped" || phase === "failed") throw new TaskAborted(`${phase}:${controller.snapshot().reason}`);
      return res;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };

  try {
    const outcome = await TASKS[name](ctx);
    m.success = outcome.success; m.detail = outcome.detail;
  } catch (error) {
    m.abortedReason = error instanceof TaskAborted ? error.message : `harness:${(error as Error).message}`;
  } finally {
    m.controllerSteps = controller.snapshot().stepCount;
    m.ms = Date.now() - started;
    finished = true;
    client.close();
    await gateway.close();
    fs.rmSync(gwDir, { recursive: true, force: true });
  }
  return m;
}

export async function main(argv: string[]) {
  const root = path.resolve(__dirname_compat(), "../../..");
  const lists = toolLists(root);
  if (argv.includes("--policy-out")) {
    // Same managed policy the product hands the daemon in desktop scope.
    fs.writeFileSync(argv[argv.indexOf("--policy-out") + 1], cuaPolicy({ kind: "desktop" }, lists.allowed, lists.denied), { mode: 0o600 });
    return;
  }
  const daemon = JSON.parse(fs.readFileSync("/tmp/cu-bench/daemon.json", "utf8")) as Daemon;
  const pick = argv.includes("--tasks") ? argv[argv.indexOf("--tasks") + 1].split(",") : Object.keys(TASKS);
  const label = argv.includes("--label") ? argv[argv.indexOf("--label") + 1] : "run";
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim();
  const results: TaskMetrics[] = [];
  for (const name of pick) {
    process.stdout.write(`[bench] ${name} ... `);
    const r = await runTask(root, daemon, lists, name);
    results.push(r);
    console.log(r.success ? "OK" : `FAIL ${r.abortedReason ?? r.detail ?? ""}`, JSON.stringify({ calls: r.agentCalls, pauses: r.pauses, interventions: r.interventions }));
  }
  const out = `/tmp/cu-bench/results-${label}-${Date.now()}.json`;
  fs.writeFileSync(out, JSON.stringify({ label, commit, at: new Date().toISOString(), results }, null, 2));
  console.log(`[bench] results -> ${out}`);
}

function __dirname_compat() { return process.env.CU_BENCH_DIR ?? process.cwd(); }
