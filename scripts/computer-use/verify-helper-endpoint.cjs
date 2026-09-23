#!/usr/bin/env node
/** Read-only local protocol smoke for a freshly built macOS/Linux cua-driver binary. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary) || process.platform === "win32") {
  console.error("Usage (macOS/Linux): node verify-helper-endpoint.cjs <built-cua-driver-binary>");
  process.exit(2);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cua-smoke-"));
const socketPath = path.join(root, "s");
const tokenFile = path.join(root, "token");
const token = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const env = {
  ...process.env,
  CUA_DRIVER_NUWAX_TOKEN_FILE: tokenFile,
  CUA_DRIVER_DATA_HOME: root,
};
const daemon = spawn(binary, [
  "serve", "--socket", socketPath,
  "--permission-mode", "unrestricted", "--dangerously-bypass-approvals",
  "--no-permissions-gate",
], { env, stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    const replies = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("daemon response timeout"));
    }, 5000);
    socket.on("connect", () => socket.write(`${lines[0]}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const reply = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        replies.push(reply);
        if (replies.length < lines.length) socket.write(`${lines[replies.length]}\n`);
        else {
          clearTimeout(timer);
          socket.destroy();
          resolve(replies);
          return;
        }
      }
    });
    socket.on("error", reject);
  });
}

(async () => {
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socketPath); i++) await sleep(100);
    if (!fs.existsSync(socketPath)) throw new Error("daemon socket not created");
    const nonce = crypto.randomBytes(16).toString("hex");
    const [proof, status] = await request([
      JSON.stringify({ method: "metadata", args: { nuwax_nonce: nonce } }),
      JSON.stringify({ method: "authorization_status", nuwax_client_token: token }),
    ]);
    const expected = crypto.createHmac("sha256", token).update(nonce).digest("hex");
    if (proof.result?.nuwax_endpoint_proof !== expected) throw new Error("server proof mismatch");
    if (!status.ok || status.result?.permission_mode !== "unrestricted") {
      throw new Error("authorized status request failed");
    }
    const [denied] = await request([JSON.stringify({ method: "authorization_status" })]);
    if (denied.ok || denied.exit_code !== 77) throw new Error("unauthorized request accepted");

    const proxy = spawn(binary, ["mcp", "--socket", socketPath], {
      env, stdio: ["pipe", "pipe", "pipe"],
    });
    let proxyError = "";
    proxy.stderr.on("data", (chunk) => { proxyError += chunk.toString("utf8"); });
    await sleep(1000);
    if (proxy.exitCode !== null) throw new Error(`MCP proxy failed startup: ${proxyError}`);
    proxy.stdin.end();
    proxy.kill();

    const stop = spawnSync(binary, ["stop", "--socket", socketPath], {
      env, encoding: "utf8", timeout: 5000,
    });
    if (stop.status !== 0) throw new Error(`CLI stop failed: ${stop.stderr}`);
    console.log("Nuwax endpoint proof, request denial, MCP proxy and CLI stop: OK");
  } finally {
    daemon.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
