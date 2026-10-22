#!/usr/bin/env node
/** Read-only native/MCP boundary smoke. No tool can reach an input actuator. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) throw new Error("Usage: node verify-helper-window-tasks.cjs <built-helper>");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cua-tasks-"));
const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\cua-tasks-" + crypto.randomUUID() : path.join(root, "s");
const tokenFile = path.join(root, "token");
const token = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const env = { ...process.env, CUA_DRIVER_NUWAX_TOKEN_FILE: tokenFile, CUA_DRIVER_DATA_HOME: root, CUA_DRIVER_NUWAX_WINDOW_TASKS: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" };
const daemon = spawn(binary, ["serve", "--socket", socketPath, "--permission-mode", "unrestricted", "--dangerously-bypass-approvals", "--no-permissions-gate"], { env, stdio: "ignore" });
let proxy;
function native(request, authenticated = true) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath); let output = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("native response timeout")); }, 5000);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("connect", () => socket.write(JSON.stringify({ ...request, ...(authenticated ? { nuwax_client_token: token } : {}) }) + "\n"));
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(output.split("\n")[0])); }
    });
  });
}
function mcpClient(child) {
  let output = "", counter = 0; const pending = new Map();
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    output += chunk;
    while (output.includes("\n")) {
      const end = output.indexOf("\n"), reply = JSON.parse(output.slice(0, end)); output = output.slice(end + 1);
      pending.get(reply.id)?.(reply); pending.delete(reply.id);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP response timeout")); }, 5000);
    pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { const reply = await native({ method: "metadata" }); ready = reply.ok === true; if (ready) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, "daemon did not start");
    assert.equal((await native({ method: "metadata" })).result.nuwax_window_tasks, 1);
    assert.equal((await native({ method: "metadata" })).result.nuwax_window_preview, 1);
    assert.equal((await native({ method: "nuwax_task", name: "states" }, false)).ok, false);
    const context = { task_id: crypto.randomUUID(), binding_id: crypto.randomUUID(), epoch: 1, pid: 2147483647, window_id: 1, host_pid: process.pid, mode: "background" };
    assert.equal((await native({ method: "nuwax_task", name: "bind", args: context })).error, "target_closed");
    assert.equal((await native({ method: "nuwax_task", name: "preview", args: context }, false)).ok, false);
    assert.equal((await native({ method: "nuwax_task", name: "preview", args: context })).error, "task_not_bound");
    assert.equal((await native({ method: "nuwax_task", name: "takeover", args: context })).error, "task_not_bound");
    const direct = async (name, args) => (await native({ method: "call", name, args })).result.structuredContent.code;
    assert.equal(await direct("click", {}), "task_context_required");
    assert.equal(await direct("bring_to_front", { _nuwax_task: context, pid: context.pid, window_id: 1 }), "scope_violation");
    assert.equal(await direct("click", { _nuwax_task: context, pid: context.pid, window_id: 1, x: 1, y: 2 }), "foreground_required");
    assert.equal(await direct("click", { _nuwax_task: context, pid: context.pid, window_id: 2, element_index: 0 }), "scope_violation");
    assert.equal(await direct("zoom", { _nuwax_task: context, pid: context.pid, window_id: 1, x: 1, y: 2 }), "task_not_bound");
    proxy = spawn(binary, ["mcp", "--socket", socketPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    const request = mcpClient(proxy);
    assert((await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "nuwax-task-smoke", version: "1" } })).result);
    const reply = await request("tools/call", { name: "get_window_state", arguments: { _nuwax_task: context, pid: context.pid, window_id: 1 } });
    assert.equal(reply.result?.structuredContent?.code, "task_not_bound", "host context must survive the real MCP proxy sanitizer");
    assert.equal((await request("tools/call", { name: "get_window_state", arguments: { pid: context.pid, window_id: 1 } })).result?.structuredContent?.code, "task_context_required");
    assert((await request("nuwax_task", { name: "bind", arguments: context })).error, "MCP must not expose native control methods");
    console.log("PASS: capability, authentication, missing task, exact target, background input refusal, read coordinates and real MCP context forwarding.");
  } finally {
    proxy?.kill(); daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
