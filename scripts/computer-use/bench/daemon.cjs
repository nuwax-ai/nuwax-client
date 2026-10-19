// Start (or reuse) a LaunchServices-launched helper daemon for benchmarking; prints state JSON path.
// Usage: node daemon.cjs start [policyFile] | stop
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const APP = process.env.CU_HELPER_APP || "/Applications/Nuwax Computer Use.app";
const BIN = path.join(APP, "Contents/MacOS/Nuwax Computer Use");
const STATE = "/tmp/cu-bench/daemon.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(policyFile) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (fs.existsSync(s.socketPath)) { console.log(STATE); return; }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-bench-"));
  fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, "s");
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const dataHome = path.join(dir, "data");
  fs.mkdirSync(dataHome, { mode: 0o700 });
  const envArgs = ["--env", `CUA_DRIVER_DATA_HOME=${dataHome}`, "--env", "CUA_DRIVER_RS_TELEMETRY_ENABLED=false",
    "--env", `CUA_DRIVER_NUWAX_TOKEN_FILE=${tokenFile}`];
  if (policyFile) envArgs.push("--env", `CUA_DRIVER_MANAGED_POLICY_FILE=${policyFile}`);
  spawnSync("open", ["-n", ...envArgs, APP, "--args",
    "serve", "--socket", socketPath, "--permission-mode", "unrestricted", "--dangerously-bypass-approvals"]);
  for (let i = 0; i < 100 && !fs.existsSync(socketPath); i++) await sleep(100);
  if (!fs.existsSync(socketPath)) throw new Error("daemon socket not created");
  fs.writeFileSync(STATE, JSON.stringify({ dir, socketPath, tokenFile, dataHome, bin: BIN, policyFile: policyFile ?? null }));
  console.log(STATE);
}

function stop() {
  if (!fs.existsSync(STATE)) return;
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  spawnSync(s.bin, ["stop", "--socket", s.socketPath], {
    env: { ...process.env, CUA_DRIVER_NUWAX_TOKEN_FILE: s.tokenFile, CUA_DRIVER_DATA_HOME: s.dataHome }, timeout: 8000 });
  fs.rmSync(s.dir, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
  console.log("stopped");
}

(async () => {
  if (process.argv[2] === "stop") stop();
  else await start(process.argv[3]);
})().catch((e) => { console.error(e.message); process.exit(1); });
