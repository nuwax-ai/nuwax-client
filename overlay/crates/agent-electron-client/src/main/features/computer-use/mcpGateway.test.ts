import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CuaMcpGateway } from "./mcpGateway";
import { CuaTaskController } from "./taskController";
import { CuaTaskRegistry } from "./taskRegistry";
import { taskCuaCall } from "./taskPolicy";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fakeDriver = `
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 const a=m.params?.arguments??{};
 if(a.hang)return;
 const structuredContent=a.refuse?{status:'refused',refusal:{code:'browser_binding_stale'}}:a.snapshot?{snapshot_id:a.snapshot}:undefined;
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:m.method==='tools/list'?[{name:'click'},{name:'check_for_update'}]:undefined,isError:a.fail===true,structuredContent,content:[{type:'text',text:'ok'}]}})+'\\n');
});`;

async function fixture(timeoutMs = 3000, authorize?: (grant: unknown) => string | null,
  transformCall?: (tool: string, args: unknown) => { tool: string; args: unknown }, tasks?: CuaTaskRegistry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\cg-${randomUUID()}` : path.join(root, "s");
  const controller = tasks ?? new CuaTaskController();
  controller.setAvailable(true);
  const failure = vi.fn();
  const results = vi.fn();
  const dispatches = vi.fn(async (owner: string, call: { tool: string; args: unknown }) => ({
    ...call, args: { ...(call.args as Record<string, unknown>), _nuwax_task: tasks!.nativeContext(owner) },
  }));
  const gateway = new CuaMcpGateway({ controller, timeoutMs, onFailure: failure, authorize, transformCall, onResult: results,
    tasks, beforeCall: tasks ? dispatches : undefined,
    allowedTools: ["get_window_state", "get_desktop_state", "get_browser_state", "click", "browser_click", "end_session"],
    ...(tasks ? { transformCall: (tool: string, args: unknown, owner?: string) => {
      const task = tasks.ensure(owner!);
      return taskCuaCall(tasks.scopeFor(owner!), task.mode, tool, args);
    } } : {}),
    launch: () => spawn(process.execPath, ["-e", fakeDriver], { stdio: ["pipe", "pipe", "pipe"] }),
  });
  await gateway.listen(socketPath, "test-token");
  cleanups.push(() => gateway.close());
  async function client(token = "test-token", initialize = true, grant?: string) {
    const socket = net.connect(socketPath);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(JSON.stringify({ token, grant }) + "\n");
    cleanups.push(() => { socket.destroy(); });
    const replies = new Map<number, (value: any) => void>();
    let buffer = "", counter = 0;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const reply = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        replies.get(reply.id)?.(reply);
        replies.delete(reply.id);
      }
    });
    const peer = { socket, request(method: string, params?: any): Promise<any> {
      const id = ++counter;
      return new Promise((resolve) => {
        replies.set(id, resolve);
        socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    } };
    if (token === "test-token" && initialize) await peer.request("initialize", {});
    return peer;
  }
  return { gateway, controller, client, failure, results, dispatches };
}

describe("multi-window MCP transport", () => {
  function tasks() {
    const tasks = new CuaTaskRegistry(); tasks.setAvailable(true);
    const a = tasks.ensure("A"), b = tasks.ensure("B");
    tasks.bind(a.id, { pid: 10, windowId: 100, label: "A" });
    tasks.bind(b.id, { pid: 20, windowId: 200, label: "B" });
    tasks.resumeTask(a.id); tasks.resumeTask(b.id);
    return { tasks, a, b };
  }
  it("delivers the native snapshot handle to content-only engines without inventing or leaking invalid observations", async () => {
    const { tasks: registry } = tasks();
    const f = await fixture(3000, () => "A", undefined, registry);
    const peer = await f.client("test-token", true, "A");
    const read = (args: unknown) => peer.request("tools/call", { name: "get_window_state", arguments: args });
    const first = await read({ snapshot: "s00000001" });
    expect(first.result.content[0].text).toContain('snapshot_id="s00000001"');
    expect(first.result.content[0].text).toContain("execution mode: background");
    expect(first.result.structuredContent).toEqual({ snapshot_id: "s00000001" });
    const next = await read({ snapshot: "s00000002" });
    expect(next.result.content[0].text).toContain('snapshot_id="s00000002"');
    expect(JSON.stringify(next.result.content)).not.toContain("s00000001");
    for (const args of [{}, { snapshot: "invalid" }, { snapshot: "s00000003", fail: true }, { snapshot: "s00000004", refuse: true }]) {
      expect(JSON.stringify((await read(args)).result.content)).not.toContain("Current window observation");
    }
    const task = registry.ensure("A"); registry.pauseTask(task.id); registry.setMode(task.id, "foreground"); registry.resumeTask(task.id);
    expect((await read({ snapshot: "s00000005" })).result.content[0].text).toContain("execution mode: foreground");
  });
  it("keeps a paused reply when revocation races the native bind acknowledgement", async () => {
    const { tasks: registry, a } = tasks();
    const f = await fixture(3000, (grant) => grant === "A" ? "A" : null, undefined, registry);
    const peer = await f.client("test-token", true, "A");
    let acknowledge!: () => void;
    f.dispatches.mockImplementationOnce(async (_owner, call) => {
      await new Promise<void>((resolve) => { acknowledge = resolve; }); return call as never;
    });
    const response = peer.request("tools/call", { name: "get_window_state" });
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    let answered = false; void response.then(() => { answered = true; });
    registry.pauseTask(a.id); f.gateway.holdOwner("A", "userPaused"); acknowledge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false); expect(f.results).not.toHaveBeenCalled();
    await f.gateway.ownerDrained("A"); registry.resumeTask(a.id);
    expect((await response).result.structuredContent.code).toBe("operationPaused");
  });
  it("rechecks the prompt grant after human target selection", async () => {
    let active = true;
    const registry = new CuaTaskRegistry(); registry.setAvailable(true);
    const f = await fixture(3000, () => active ? "A" : null, undefined, registry);
    const peer = await f.client("test-token", true, "A");
    const response = peer.request("tools/call", { name: "get_window_state" });
    await vi.waitFor(() => expect(registry.stateForOwner("A")).toBeDefined());
    const task = registry.ensure("A"); active = false;
    registry.bind(task.id, { pid: 10, windowId: 100, label: "A" }); registry.resumeTask(task.id);
    expect((await response).result.structuredContent.code).toBe("sessionRequired");
    expect(f.dispatches).not.toHaveBeenCalled();
  });
  it("cancels one session while another task continues, then reconnects only the drained owner", async () => {
    const { tasks: registry, a, b } = tasks();
    const f = await fixture(3000, (grant) => grant === "A" || grant === "B" ? grant : null, undefined, registry);
    const ca = await f.client("test-token", true, "A"), cb = await f.client("test-token", true, "B");
    await ca.request("tools/call", { name: "get_window_state" });
    await cb.request("tools/call", { name: "get_window_state" });
    const inFlight = ca.request("tools/call", { name: "click", arguments: { element_index: 0, hang: true } });
    await vi.waitFor(() => expect(f.dispatches.mock.calls.some((call) => call[0] === "A" && call[1].tool === "click")).toBe(true));
    let answered = false; void inFlight.then(() => { answered = true; });
    registry.pauseTask(a.id); f.gateway.holdOwner("A", "userPaused");
    await Promise.resolve(); expect(answered).toBe(false);
    expect((await cb.request("tools/call", { name: "click", arguments: { element_index: 0 } })).result.isError).toBe(false);
    expect(registry.stateForOwner("B")?.taskId).toBe(b.id);
    await f.gateway.ownerDrained("A");
    expect(registry.resumeTask(a.id)).toBe(true);
    expect((await inFlight).result.structuredContent.code).toBe("operationPaused");
    expect((await ca.request("tools/call", { name: "click", arguments: { element_index: 0 } })).result.structuredContent.code).toBe("observationRequired");
    expect((await ca.request("tools/call", { name: "get_window_state" })).result.isError).toBe(false);
  });
  it("keeps the first tool call and its ACP grant alive while the user selects a window", async () => {
    const registry = new CuaTaskRegistry(); registry.setAvailable(true);
    const f = await fixture(3000, (grant) => grant === "A" ? "A" : null, undefined, registry);
    const a = await f.client("test-token", true, "A");
    const first = a.request("tools/call", { name: "get_window_state" });
    await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
    expect(f.dispatches).not.toHaveBeenCalled();
    const id = registry.list()[0].taskId;
    registry.bind(id, { pid: 10, windowId: 100, label: "chosen by user" });
    expect(f.dispatches).not.toHaveBeenCalled();
    registry.resumeTask(id);
    expect((await first).result.isError).toBe(false);
    expect(registry.list()[0].stepCount).toBe(1);
  });
  it("rejects foreign targets, forged foreground requests and raw protocol bypasses", async () => {
    const { tasks: registry, a: task } = tasks();
    const f = await fixture(3000, (grant) => grant === "A" ? "A" : null, undefined, registry);
    const a = await f.client("test-token", true, "A");
    expect((await a.request("tools/call", { name: "click", arguments: { pid: 20, element_index: 0 } })).result.structuredContent.code).toBe("scopeViolation");
    const foreground = a.request("tools/call", { name: "click", arguments: { delivery_mode: "foreground" } });
    let answered = false; void foreground.then(() => { answered = true; });
    await vi.waitFor(() => expect(registry.stateForOwner("A")?.reason).toBe("foregroundRequired"));
    expect(answered).toBe(false); registry.resumeTask(task.id);
    expect((await foreground).result.structuredContent.code).toBe("operationPaused");
    expect((await a.request("cua/driver/v1/open", {})).error).toBeDefined();
    expect(f.dispatches).not.toHaveBeenCalled();
  });
});
describe("CUA MCP gateway over real local sockets", () => {
  it("forwards initialization and applies observation / ownership gates to real tool traffic", async () => {
    const f = await fixture();
    const a = await f.client(), b = await f.client();
    expect((await a.request("initialize", {})).result.content[0].text).toBe("ok");
    expect((await a.request("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["click"]);
    expect((await a.request("tools/call", { name: "click" })).result.structuredContent.code).toBe("observationRequired");
    expect((await a.request("tools/call", { name: "get_desktop_state" })).result.isError).toBe(false);
    expect((await b.request("tools/call", { name: "click" })).result.structuredContent.code).toBe("desktopBusy");
    expect((await a.request("tools/call", { name: "check_for_update" })).result.structuredContent.code).toBe("toolNotAllowed");
    await a.request("tools/call", { name: "end_session" });
    expect((await b.request("tools/call", { name: "get_desktop_state" })).result.isError).toBe(false);
  });
  it("rejects wrong capabilities before spawning a driver", async () => {
    const f = await fixture();
    const a = await f.client("wrong");
    await new Promise<void>((resolve) => a.socket.once("close", resolve));
    expect(f.controller.snapshot().phase).toBe("idle");
  });
  it("bounds an uncertain action and never reports timeout as success", async () => {
    const f = await fixture(250);
    const a = await f.client();
    await a.request("tools/call", { name: "get_desktop_state" });
    const result = await a.request("tools/call", { name: "click", arguments: { hang: true } });
    expect(result.result.structuredContent.code).toBe("toolTimeout");
    expect(f.controller.snapshot().phase).toBe("paused");
    expect(f.failure).toHaveBeenCalledWith("toolTimeout");
  });
  it("returns cancellation to pending callers and prevents a stopped connection from continuing", async () => {
    const f = await fixture();
    const a = await f.client();
    await a.request("tools/call", { name: "get_desktop_state" });
    const pending = a.request("tools/call", { name: "click", arguments: { hang: true } });
    await vi.waitFor(() => expect(f.controller.snapshot().steps.at(-1)?.tool).toBe("click"));
    f.controller.stop();
    f.gateway.cancelPending("userStopped");
    expect((await pending).result.structuredContent.code).toBe("userStopped");
    expect((await a.request("tools/call", { name: "click" })).result.structuredContent.code).toBe("taskStopped");
  });
  it("reconnects only the driver transport and requires observation before resuming writes", async () => {
    const f = await fixture();
    const a = await f.client();
    await a.request("initialize", {});
    await a.request("tools/call", { name: "get_desktop_state" });
    f.controller.pause(); f.gateway.pauseTransports();
    expect((await a.request("tools/call", { name: "click" })).result.isError).toBe(true);
    await f.gateway.resumeTransports();
    expect(f.controller.resume()).toBe(true);
    expect((await a.request("tools/call", { name: "click" })).result.structuredContent.code).toBe("observationRequired");
    await a.request("tools/call", { name: "get_desktop_state" });
    expect((await a.request("tools/call", { name: "click" })).result.isError).toBe(false);
  });
  it("does not expose tool arguments in task snapshots", async () => {
    const f = await fixture();
    const a = await f.client();
    await a.request("tools/call", { name: "get_desktop_state", arguments: { secret: "test-secret" } });
    expect(JSON.stringify(f.controller.snapshot())).not.toContain("test-secret");
  });
  it("uses protocol errors for uninitialized calls and discovery during pause", async () => {
    const f = await fixture();
    const a = await f.client("test-token", false);
    expect((await a.request("tools/call", { name: "click" })).error.message).toContain("notInitialized");
    await a.request("initialize", {});
    await a.request("tools/call", { name: "get_desktop_state" });
    f.controller.pause(); f.gateway.pauseTransports();
    expect((await a.request("tools/list")).error.message).toContain("userPaused");
  });
  it("stops driver activity only on uncertain writes and no-progress limits", async () => {
    const f = await fixture();
    const a = await f.client();
    await a.request("tools/call", { name: "get_desktop_state", arguments: { fail: true } });
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.controller.snapshot().phase).toBe("running");
    await a.request("tools/call", { name: "get_desktop_state" });
    await a.request("tools/call", { name: "click", arguments: { fail: true } });
    expect(f.failure).toHaveBeenCalledWith("uncertainResult");
    f.controller.resume();
    for (let i = 0; i < 3; i++) {
      await a.request("tools/call", { name: "get_desktop_state" });
      await a.request("tools/call", { name: "click" });
    }
    await a.request("tools/call", { name: "get_desktop_state" });
    expect((await a.request("tools/call", { name: "click" })).result.structuredContent.code).toBe("noProgress");
    expect(f.failure).toHaveBeenCalledWith("noProgress");
  });
  it("does not let a refusal without isError count as an observation, and tells the model it did nothing", async () => {
    const f = await fixture();
    const a = await f.client();
    const tab = { target_id: "bt", tab_id: "t" };
    const refused = await a.request("tools/call", { name: "get_browser_state", arguments: { ...tab, refuse: true } });
    expect(refused.result.content.at(-1).text).toContain("refused and had no effect");
    expect((await a.request("tools/call", { name: "browser_click", arguments: { ...tab, ref: "p1:1" } })).result.structuredContent.code).toBe("observationRequired");
    await a.request("tools/call", { name: "get_browser_state", arguments: tab });
    const click = await a.request("tools/call", { name: "browser_click", arguments: { ...tab, ref: "p1:1", refuse: true } });
    expect(click.result.structuredContent.refusal.code).toBe("browser_binding_stale");
    expect(f.controller.snapshot().phase).toBe("running");
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.results).toHaveBeenCalledWith("browser_click", expect.objectContaining({ ref: "p1:1" }), "refused", expect.anything());
  });
  it("adds model guidance to initialize and tool descriptions exactly once", async () => {
    const f = await fixture();
    const a = await f.client("test-token", false);
    const init = await a.request("initialize", {});
    expect(init.result.instructions).toContain("Look before you act");
    expect(init.result.instructions).toContain("not allowed in this mode");
    for (let i = 0; i < 2; i++) {
      const [click] = (await a.request("tools/list")).result.tools;
      expect(click.description).toBe("[Nuwax] For web page content prefer browser_click.");
    }
  });
  it("ends the task after repeated violations but not for a closed target", async () => {
    const f = await fixture(3000, undefined, (tool, args) => {
      if ((args as { closed?: boolean }).closed) throw new Error("targetClosed");
      if ((args as { escape?: boolean }).escape) throw new Error("scopeViolation");
      return { tool, args };
    });
    const a = await f.client();
    await a.request("tools/call", { name: "get_desktop_state" });
    for (let i = 0; i < 4; i++) {
      expect((await a.request("tools/call", { name: "click", arguments: { closed: true } })).result.structuredContent.code).toBe("targetClosed");
    }
    expect((await a.request("tools/call", { name: "check_for_update" })).result.structuredContent.code).toBe("toolNotAllowed");
    expect((await a.request("tools/call", { name: "click", arguments: { escape: true } })).result.structuredContent.code).toBe("scopeViolation");
    expect(f.controller.snapshot().phase).toBe("running");
    await a.request("tools/call", { name: "click", arguments: { escape: true } });
    expect(f.controller.snapshot()).toMatchObject({ phase: "stopped", reason: "violationLimit" });
    expect((await a.request("tools/call", { name: "get_desktop_state" })).result.structuredContent.code).toBe("taskStopped");
  });
  it("cancels a call still in flight when violations end the task", async () => {
    const f = await fixture(3000, undefined, (tool, args) => {
      if ((args as { escape?: boolean }).escape) throw new Error("scopeViolation");
      return { tool, args };
    });
    const a = await f.client();
    await a.request("tools/call", { name: "get_desktop_state" });
    const pending = a.request("tools/call", { name: "click", arguments: { hang: true } });
    await vi.waitFor(() => expect(f.controller.snapshot().steps.at(-1)?.tool).toBe("click"));
    for (let i = 0; i < 3; i++) await a.request("tools/call", { name: "click", arguments: { escape: true } });
    expect((await pending).result.structuredContent.code).toBe("violationLimit");
  });
});


describe("CUA session-granted transport", () => {
  it("rejects missing/idle credentials, isolates sessions, and blocks revoked late requests", async () => {
    const active = new Map<string, string>();
    const f = await fixture(3000, (grant) => active.get(String(grant)) ?? null);
    const a = await f.client("test-token", true, "session-a"), b = await f.client("test-token", true, "session-b");
    const call = (peer: typeof a) => peer.request("tools/call", { name: "get_desktop_state" });
    expect((await call(a)).result.structuredContent.code).toBe("sessionRequired");
    active.set("session-a", "owner-a"); active.set("session-b", "owner-b");
    expect((await call(a)).result.isError).toBe(false);
    expect((await call(b)).result.structuredContent.code).toBe("desktopBusy");
    active.delete("session-a"); f.controller.stop("sessionEnded"); f.controller.retire("owner-a");
    expect((await call(a)).result.structuredContent.code).toBe("sessionRequired");
    expect((await call(b)).result.isError).toBe(false);
    active.clear();
    expect((await call(b)).result.structuredContent.code).toBe("sessionRequired");
  });
  it("does not let reconnect bypass a stopped session, and reclaims the helper lease between prompts", async () => {
    const f = await fixture(3000, () => "owner");
    const a = await f.client();
    const params = { name: "get_desktop_state" };
    await a.request("tools/call", params);
    f.controller.complete("owner");
    await f.gateway.releaseOwner("owner");
    expect((await a.request("tools/call", params)).result.isError).toBe(false);
    f.controller.stop(); a.socket.destroy();
    await new Promise<void>((resolve) => a.socket.once("close", resolve));
    const reconnect = await f.client();
    expect((await reconnect.request("tools/call", params)).result.structuredContent.code).toBe("taskStopped");
  });
  it("reclaims transport children and connections across repeated completion/reconnect cycles", async () => {
    // Thirty reconnects start sixty real Node children. Give process startup its
    // own stress-test budget; individual tool deadlines remain tested above.
    const f = await fixture(3000, () => "owner");
    for (let i = 0; i < 30; i++) {
      const peer = await f.client();
      expect((await peer.request("tools/call", { name: "get_desktop_state" })).result.isError).toBe(false);
      f.controller.complete("owner"); await f.gateway.releaseOwner("owner");
      peer.socket.destroy(); await new Promise<void>((resolve) => peer.socket.once("close", resolve));
    }
    await f.gateway.close(); expect(f.gateway.ready).toBe(false);
    expect(f.controller.snapshot().phase).toBe("completed");
  }, 60000);
});
