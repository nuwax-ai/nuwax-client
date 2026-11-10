import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDesktopAdapter } from "./agentDesktop";
import type { DesktopRun } from "./agentDesktopProcess";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CuaTaskRegistry } from "./taskRegistry";
import { CuaTaskController } from "./taskController";
import { classifyReply } from "./cuaOutcome";

const nativeWindow = { pid: 42, id: "w-7", process_instance: "process-a", app_name: "Fixture", title: "Example", accessible: true, visible: true, is_focused: false };
function fixture() {
  const state = { windows: [{ ...nativeWindow }], snapshotPid: 42, sensitive: false, delivery: "delivered_verified" };
  const run = vi.fn<DesktopRun>(async args => {
    if (args[0] === "list-windows") return { ok: true, data: state.windows };
    if (args[0] === "snapshot") return { ok: true, data: { app: "Fixture", pid: state.snapshotPid, process_instance: "process-a", window: { id: "w-7" }, complete: true,
      tree: { role: "window", children: [{ role: state.sensitive ? "securetextfield" : "textfield", name: "Input", ref_id: "@sxyz123:e2", value: "before" }] } } };
    if (args[0] === "permissions") return { ok: true, data: { accessibility: { state: "granted" }, screen_recording: { state: "denied" } } };
    return { ok: true, data: { disposition: { delivery: state.delivery } } };
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-adapter-test-"));
  const adapter = new AgentDesktopAdapter(run, home); adapter.start();
  const connections: ReturnType<AgentDesktopAdapter["transport"]>[] = [];
  let sequence = 0;
  function connect() {
    const transport = adapter.transport(); connections.push(transport);
    let buffer = "";
    const pending = new Map<number, (value: any) => void>();
    transport.stdout.on("data", chunk => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        pending.get(message.id)?.(message.result ?? message.error); pending.delete(message.id);
      }
    });
    return (name: string, args: Record<string, any> = {}) => new Promise<any>(resolve => {
      const id = ++sequence; pending.set(id, resolve);
      transport.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });
  }
  return { adapter, run, state, connect, target: { pid: 42, window_id: 1 }, cleanup: async () => { await adapter.stop(); fs.rmSync(home, { recursive: true, force: true }); } };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
function setup() { const value = fixture(); cleanups.push(value.cleanup); return value; }

describe("Agent Desktop adapter", () => {
  it("can recheck permissions after disabling without restarting desktop execution", async () => {
    const { adapter } = setup(); await adapter.stop();
    expect(await adapter.permissions()).toEqual({ accessibility: true, screenRecording: false });
    expect(adapter.running).toBe(false);
  });
  it("maps exact native refs and sends text over stdin without shell or physical input", async () => {
    const { connect, target, run } = setup(), call = connect();
    const observed = (await call("get_window_state", target)).structuredContent;
    expect(observed.elements[1].element_token).toMatch(/^s[0-9a-f]{8}:1$/);
    const reply = await call("set_value", { ...target, snapshot_id: observed.snapshot_id, element_index: 1, value: "a$`b" });
    expect(reply.structuredContent.status).toBe("ok");
    expect(run).toHaveBeenLastCalledWith(["set-value", "@sxyz123:e2", "--stdin"], expect.objectContaining({ input: "a$`b" }));
  });
  it("rejects stale, foreign and reused observation evidence without delivering writes", async () => {
    const { connect, target, run } = setup(), first = connect(), second = connect();
    const old = (await first("get_window_state", target)).structuredContent;
    const args = { ...target, snapshot_id: old.snapshot_id, element_index: 1 };
    expect((await second("click", args)).structuredContent.code).toBe("staleObservation");
    await first("get_window_state", target);
    expect((await first("click", args)).structuredContent.code).toBe("staleObservation");
    const fresh = (await first("get_window_state", target)).structuredContent;
    await first("click", { ...args, snapshot_id: fresh.snapshot_id });
    expect((await first("click", { ...args, snapshot_id: fresh.snapshot_id })).structuredContent.code).toBe("staleObservation");
    expect(run.mock.calls.filter(([args]) => args[0] === "click")).toHaveLength(1);
  });
  it("does not alias a recycled process/window or accept a snapshot from another process", async () => {
    const { connect, target, state } = setup(), call = connect();
    state.snapshotPid = 99;
    expect((await call("get_window_state", target)).structuredContent.code).toBe("scopeViolation");
    state.snapshotPid = 42; state.windows[0].process_instance = "process-b";
    expect((await call("get_window_state", target)).structuredContent.code).toBe("targetClosed");
  });
  it("withholds password observations and never exposes unrestricted commands", async () => {
    const { connect, target, state, run } = setup(), call = connect(); state.sensitive = true;
    const reply = await call("get_window_state", target);
    expect(reply.structuredContent.code).toBe("sensitiveObservation");
    expect(JSON.stringify(reply)).not.toContain("before");
    expect((await call("launch_app", { command: "sh" })).structuredContent.code).toBe("toolNotAllowed");
    expect(run.mock.calls.some(([args]) => args[0] === "launch")).toBe(false);
  });
  it("allows a host observation after confirmed delivery without replaying the consumed action", async () => {
    const { connect, target, state, run } = setup(), call = connect();
    const controller = new CuaTaskController(); controller.setAvailable(true);
    const read = controller.begin("owner", "get_window_state", target).permit!;
    const observed = (await call("get_window_state", target)).structuredContent;
    controller.finish(read, "ok", observed);
    state.delivery = "delivered_unverified";
    const args = { ...target, snapshot_id: observed.snapshot_id, element_index: 1 };
    const write = controller.begin("owner", "click", args).permit!;
    const result = await call("click", args);
    expect(result).toMatchObject({ structuredContent: { status: "ok", effect: "delivered_unverified", retryable: false, needsObservation: true } });
    controller.finish(write, classifyReply("click", { result }), result.structuredContent);
    expect(controller.snapshot()).toMatchObject({ phase: "running", resultObserved: false });
    expect((await call("click", args)).structuredContent.code).toBe("staleObservation");
    const verify = controller.begin("owner", "get_window_state", target).permit!;
    expect(verify).toBeDefined();
    const after = (await call("get_window_state", target)).structuredContent;
    controller.finish(verify, "ok", after);
    expect(controller.snapshot()).toMatchObject({ phase: "running", resultObserved: true });
    expect(run.mock.calls.filter(([args]) => args[0] === "click")).toHaveLength(1);
  });
  it.each(["delivery_uncertain", "unknown", "missing"])("keeps %s delivery paused and never replays it", async delivery => {
    const { connect, target, state, run } = setup(), call = connect();
    const observed = (await call("get_window_state", target)).structuredContent;
    state.delivery = delivery;
    const args = { ...target, snapshot_id: observed.snapshot_id, element_index: 1 };
    const result = await call("click", args);
    expect(classifyReply("click", { result })).toBe("uncertain");
    expect((await call("click", args)).structuredContent.code).toBe("staleObservation");
    expect(run.mock.calls.filter(([args]) => args[0] === "click")).toHaveLength(1);
  });
  it("does not hide an upstream failure after partial delivery", async () => {
    const { connect, target, run } = setup(), call = connect();
    const observed = (await call("get_window_state", target)).structuredContent;
    run.mockResolvedValueOnce({ ok: true, data: [nativeWindow] });
    run.mockResolvedValueOnce({ ok: false, error: { code: "verification_failed", disposition: { delivery: "delivered_unverified" } } });
    expect((await call("click", { ...target, snapshot_id: observed.snapshot_id, element_index: 1 })).structuredContent.status).toBe("uncertain");
  });
  it("revokes in-flight task input, waits for cancellation, and refuses further use", async () => {
    const { adapter, connect, target, run } = setup(), call = connect();
    const context = { ...target, task_id: "task-a", binding_id: "binding-a", host_pid: process.pid, epoch: 1, mode: "background" };
    expect((await adapter.request("nuwax_task", "bind", context)).ok).toBe(true);
    const observed = (await call("get_window_state", { ...target, _nuwax_task: context })).structuredContent;
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (args, options) => {
      if (args[0] !== "click") return original(args, options);
      dispatched();
      return new Promise((_, reject) => options.signal!.addEventListener("abort", () => reject(new Error("operationCancelled")), { once: true }));
    });
    const pending = call("click", { ...target, _nuwax_task: context, snapshot_id: observed.snapshot_id, element_index: 1 });
    await started;
    expect((await adapter.request("nuwax_task", "revoke", context)).result?.drained).toBe(true);
    expect((await pending).structuredContent.status).toBe("uncertain");
    expect((await call("get_window_state", { ...target, _nuwax_task: context })).structuredContent.status).toBe("refused");
  });
  it("refuses forged task contexts and foreground escalation", async () => {
    const { adapter, connect, target } = setup(), call = connect();
    expect((await adapter.request("nuwax_task", "bind", { ...target, task_id: "a", binding_id: "b", host_pid: -1, epoch: 1, mode: "background" })).ok).toBe(false);
    const observed = (await call("get_window_state", target)).structuredContent;
    expect((await call("click", { ...target, snapshot_id: observed.snapshot_id, element_index: 1, delivery_mode: "foreground" })).structuredContent.code).toBe("engineCapabilityUnsupported");
  });
  it("acknowledges a repeated drain after forget without rearming the old input lease", async () => {
    const { adapter, connect, target, run } = setup(), call = connect();
    const context = { ...target, task_id: "finished-task", binding_id: "binding", host_pid: process.pid, epoch: 1, mode: "background" };
    await adapter.request("nuwax_task", "bind", context);
    const observed = (await call("get_window_state", { ...target, _nuwax_task: context })).structuredContent;
    expect((await adapter.request("nuwax_task", "forget", context)).ok).toBe(true);
    expect(await adapter.request("nuwax_task", "revoke", { ...context, epoch: 2 })).toMatchObject({ ok: true, result: { drained: true } });
    expect((await call("click", { ...target, _nuwax_task: context, snapshot_id: observed.snapshot_id, element_index: 1 })).isError).toBe(true);
    expect(run.mock.calls.some(([args]) => args[0] === "click")).toBe(false);
  });
  it("drains and resumes the real host task epochs without rearming a revoked generation", async () => {
    const { adapter, connect, target } = setup();
    const tasks = new CuaTaskRegistry(); tasks.setAvailable(true);
    const task = tasks.ensure("owner"); tasks.bind(task.id, { pid: target.pid, windowId: target.window_id, label: "Fixture" });
    let context = tasks.nativeContext("owner");
    expect((await adapter.request("nuwax_task", "bind", context)).ok).toBe(true);
    expect((await adapter.request("nuwax_task", "revoke", context)).result?.drained).toBe(true);
    expect(tasks.resumeTask(task.id)).toBe(true);
    context = tasks.nativeContext("owner");
    expect((await adapter.request("nuwax_task", "bind", context)).ok).toBe(true);
    const first = connect();
    const observed = (await first("get_window_state", { ...target, _nuwax_task: context })).structuredContent;
    tasks.pauseTask(task.id, "userPaused");
    const paused = tasks.nativeContext("owner"); expect(paused.epoch).toBeGreaterThan(context.epoch);
    expect((await adapter.request("nuwax_task", "revoke", paused)).result?.drained).toBe(true);
    expect((await adapter.request("nuwax_task", "bind", context)).ok).toBe(false);
    expect((await adapter.request("nuwax_task", "bind", paused)).ok).toBe(false);
    expect((await first("click", { ...target, _nuwax_task: context, snapshot_id: observed.snapshot_id, element_index: 1 })).isError).toBe(true);
    expect((await adapter.request("nuwax_task", "window", paused)).result?.valid).toBe(true);
    expect(tasks.resumeTask(task.id)).toBe(true);
    context = tasks.nativeContext("owner");
    expect((await adapter.request("nuwax_task", "bind", context)).ok).toBe(true);
    expect((await connect()("get_window_state", { ...target, _nuwax_task: context })).structuredContent.status).toBe("ok");
    tasks.stopTask(task.id);
    expect((await adapter.request("nuwax_task", "revoke", tasks.nativeContext("owner"))).result?.drained).toBe(true);
  });
});
