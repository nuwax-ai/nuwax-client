#!/usr/bin/env node
/**
 * Read-only regression for the reply shapes the gateway's classifier relies on
 * (overlay/.../cua/cuaOutcome.ts). Starts a private daemon and calls tools on targets that
 * do not exist, so nothing on screen is touched and no system permission is needed.
 * Run after every helper upgrade:
 *   node scripts/computer-use/verify-helper-refusals.cjs <built-cua-driver-binary>
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary) || process.platform === "win32") {
  console.error("Usage (macOS/Linux): node verify-helper-refusals.cjs <built-cua-driver-binary>");
  process.exit(2);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cua-refusals-"));
const socketPath = path.join(root, "s");
const tokenFile = path.join(root, "token");
fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
const env = { ...process.env, CUA_DRIVER_NUWAX_TOKEN_FILE: tokenFile, CUA_DRIVER_DATA_HOME: root, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" };
const daemon = spawn(binary, ["serve", "--socket", socketPath, "--permission-mode", "unrestricted",
  "--dangerously-bypass-approvals", "--no-permissions-gate"], { env, stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const refused = (sc) => !!sc && (sc.status === "refused" || sc.effect === "refused" || (sc.refusal && typeof sc.refusal === "object"));
// [tool, args, check(reply) -> error string | null]
const CASES = [
  ["get_window_state", { pid: 999999, window_id: 999999 }, (r) => r.result?.isError === true ? null : "read failure must set isError"],
  ["click", { pid: 999999, window_id: 999999, element_index: 3, snapshot_id: "bogus" }, (r) => refused(r.result?.structuredContent) ? null : "bad snapshot must be a refusal"],
  // 0.38 accepts pid-less element tokens and refuses unknown tokens explicitly;
  // both shapes must remain a provable no-delivery outcome for cuaOutcome.ts.
  ["click", { element_token: "s00000001:11" }, (r) => {
    const sc = r.result?.structuredContent;
    return r.result?.isError === true && (sc?.code === "tool_invocation_failed" ||
      refused(sc) && sc.refusal?.code === "stale_element_token") ? null : "unknown token must be a refusal";
  }],
  ["scroll", { pid: 999999, direction: "down" }, (r) => refused(r.result?.structuredContent) ? null : "missing target must be a refusal"],
  ["get_browser_state", { target_id: "bogus", tab_id: "bogus" }, (r) => refused(r.result?.structuredContent) ? null : "stale binding must be a refusal"],
  ["browser_click", { target_id: "bogus", tab_id: "bogus", ref: "p1:1" }, (r) => refused(r.result?.structuredContent) ? null : "browser click on stale binding must be a refusal"],
  ["browser_navigate", { target_id: "bogus", tab_id: "bogus", url: "https://example.com" }, (r) => refused(r.result?.structuredContent) ? null : "navigate on stale binding must be a refusal"],
  ["get_browser_state", { pid: 999999, window_id: 999999 }, (r) => refused(r.result?.structuredContent) ? null : "non-browser bind must be a refusal"],
];

(async () => {
  let failures = 0;
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socketPath); i++) await sleep(100);
    if (!fs.existsSync(socketPath)) throw new Error("daemon socket not created");
    const proxy = spawn(binary, ["mcp", "--socket", socketPath], { env, stdio: ["pipe", "pipe", "ignore"] });
    const replies = new Map();
    let buffer = "";
    proxy.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) { try { const m = JSON.parse(line); if (m.id !== undefined) replies.set(m.id, m); } catch { /* not ours */ } }
    });
    const send = (m) => proxy.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    CASES.forEach(([name, args], i) => send({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
    for (let i = 0; i < 150 && replies.size < CASES.length + 1; i++) await sleep(100);
    CASES.forEach(([name, , check], i) => {
      const reply = replies.get(i + 1);
      const problem = reply ? check(reply) : "no reply";
      if (problem) failures++;
      console.log(`${problem ? "FAIL" : "ok  "} ${name}${problem ? ` — ${problem}: ${JSON.stringify(reply?.result?.structuredContent ?? reply?.error ?? null).slice(0, 300)}` : ""}`);
    });
    proxy.kill();
  } catch (error) {
    failures++;
    console.error(`FAIL ${error.message}`);
  } finally {
    daemon.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(failures ? 1 : 0);
})();
