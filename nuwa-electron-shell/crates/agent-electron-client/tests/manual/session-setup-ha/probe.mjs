#!/usr/bin/env node
/**
 * 对随包的 nuwaxcode 引擎复现「会话建立阶段」的几种情况（session-setup-ha 的手动验证工具）。
 *
 * 直接以 ACP（stdio 上的 NDJSON JSON-RPC）驱动引擎二进制，不经过 Electron，
 * 用来确认引擎侧行为与主进程恢复链路（acpSessionRecovery.ts）的假设一致：
 *
 *   clean    会话不存在时 session/load 立即报错（不是挂起）；session/new、
 *            对已存在会话的 session/load 正常返回。
 *   slowmcp  MCP 服务 20 秒才就绪时，session/load 要等到 MCP 就绪才返回 ——
 *            所以宿主侧的恢复超时必须比冷启动 MCP 的时长更长。
 *   hangdir  工作目录的启动挂死时，session/load 与回退的 session/new 都无响应，
 *            同进程里另一个干净目录照常可用 —— 所以硬超时后要换进程，
 *            再不行就隔离这个会话的引擎 home。
 *
 * 用法：
 *   node tests/manual/session-setup-ha/probe.mjs <clean|slowmcp|hangdir> [--fast]
 *
 * --fast 把各处等待按 1/5 缩短，只适合冒烟；默认等待与 acpSetupBudgets 的预算对齐。
 * 所有文件（HOME、XDG 目录、工作目录）都建在系统临时目录下的一个新目录里，
 * 跑完即删；引擎进程在结束时被杀掉。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const crateRoot = path.resolve(here, "../../..");

function resolveEngineBinary() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const dir = path.join(
    crateRoot,
    "resources",
    "nuwaxcode",
    `${process.platform}-${arch}`,
    "bin",
  );
  const name = process.platform === "win32" ? "nuwaxcode.exe" : "nuwaxcode";
  const binary = path.join(dir, name);
  if (!fs.existsSync(binary)) {
    throw new Error(
      `找不到随包引擎：${binary}\n先执行 npm run prepare（或确认 resources/nuwaxcode 已就位）。`,
    );
  }
  return binary;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;

class Engine {
  static async start(binary, { home, cwd, env }) {
    const port = await freePort();
    for (const sub of [
      ".config",
      path.join(".local", "share"),
      ".cache",
      path.join(".local", "state"),
    ]) {
      fs.mkdirSync(path.join(home, sub), { recursive: true });
    }
    return new Engine(binary, { home, cwd, port, env });
  }

  constructor(binary, { home, cwd, port, env }) {
    this.port = port;
    this.responses = new Map();
    this.sentAt = new Map();
    this.notifications = 0;
    this.nextId = 0;
    this.buffer = "";
    this.t0 = Date.now();
    this.child = spawn(
      binary,
      ["acp", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          XDG_STATE_HOME: path.join(home, ".local", "state"),
          GIT_TERMINAL_PROMPT: "0",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.ready = new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onOutput(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.trace("ERR", chunk.trimEnd()));
    this.child.stdin.on("error", () => {});
  }

  trace(tag, line) {
    const elapsed = ((Date.now() - this.t0) / 1000).toFixed(3).padStart(7);
    // 引擎有时会输出带换行的多行内容，压成一行便于过滤和阅读
    const flat = String(line).replace(/\s*\n\s*/g, " ");
    process.stdout.write(`${elapsed} ${tag} ${flat.slice(0, 240)}\n`);
  }

  onOutput(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      this.trace("OUT", line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if ("method" in message && !("id" in message)) {
        this.notifications += 1;
      } else if ("id" in message) {
        this.responses.set(message.id, { at: Date.now(), message });
      }
    }
  }

  /** 发请求并等响应；超时返回 null（底层 RPC 不会被取消，与宿主侧一致）。 */
  async request(method, params, timeoutMs) {
    await this.ready;
    const id = this.nextId++;
    const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.trace("SEND", text);
    this.sentAt.set(id, Date.now());
    this.child.stdin.write(`${text}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.responses.has(id)) return this.settled(id);
      await sleep(25);
    }
    return this.responses.has(id) ? this.settled(id) : null;
  }

  /** 之前超时的请求现在是否已有响应；有则带实际耗时返回。 */
  settled(id) {
    const response = this.responses.get(id);
    if (!response) return null;
    return { ...response, latencyMs: response.at - (this.sentAt.get(id) ?? response.at) };
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      // 进程可能已退出
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      // 同上
    }
  }
}

function describe(response) {
  if (!response) return "无响应";
  if (response.message.error) {
    return `ERROR ${JSON.stringify(response.message.error).slice(0, 160)}`;
  }
  const result = response.message.result;
  if (result && result.sessionId) return `OK sessionId=${result.sessionId}`;
  return `OK keys=${
    result && typeof result === "object" ? Object.keys(result).join(",") : typeof result
  }`;
}

function withLatency(response) {
  return response ? `${describe(response)}（${seconds(response.latencyMs)}）` : describe(response);
}

function print(title, out) {
  console.log(`\n===== ${title} =====`);
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value)) {
      console.log(`${key}:`);
      for (const line of value) console.log(`  ${line}`);
    } else {
      console.log(`${key}: ${value}`);
    }
  }
}

function engineLogTail(home) {
  const file = path.join(home, ".local", "share", "opencode", "log", "opencode.log");
  if (!fs.existsSync(file)) return ["（引擎没有写日志）"];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-12)
    .map((line) => line.replace(/^timestamp=\S+\s+level=(\w+)\s+/, "[$1] ").slice(0, 170));
}

async function scenarioClean(binary, work, wait) {
  const home = path.join(work, "home");
  const clean = path.join(work, "clean");
  fs.mkdirSync(clean, { recursive: true });
  const engine = await Engine.start(binary, { home, cwd: work });
  const out = {};
  try {
    out.initialize = withLatency(
      await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(30_000)),
    );
    out["load（会话不存在）"] = withLatency(
      await engine.request(
        "session/load",
        { sessionId: "ses_doesnotexist0000000000000", cwd: clean, mcpServers: [] },
        wait(40_000),
      ),
    );
    const created = await engine.request("session/new", { cwd: clean, mcpServers: [] }, wait(40_000));
    out["new"] = withLatency(created);
    const sessionId = created?.message.result?.sessionId;
    out["load（刚建的会话）"] = withLatency(
      await engine.request("session/load", { sessionId, cwd: clean, mcpServers: [] }, wait(40_000)),
    );
  } finally {
    engine.close();
  }
  return out;
}

async function scenarioSlowMcp(binary, work, wait) {
  const home = path.join(work, "home");
  const clean = path.join(work, "clean");
  fs.mkdirSync(clean, { recursive: true });
  const mcpDelayMs = wait(20_000);
  const mcp = [
    {
      name: "slow",
      command: process.execPath,
      args: [path.join(here, "slow-mcp-server.mjs"), String(mcpDelayMs)],
      env: [],
      headers: [],
    },
  ];
  const engine = await Engine.start(binary, { home, cwd: work });
  const out = { "MCP 就绪耗时": seconds(mcpDelayMs) };
  try {
    await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(30_000));
    const created = await engine.request("session/new", { cwd: clean, mcpServers: [] }, wait(40_000));
    const sessionId = created?.message.result?.sessionId;

    // 先按旧的恢复超时（15 秒）等：健康但慢的恢复会被判成超时
    const oldBudgetMs = wait(15_000);
    const load = await engine.request(
      "session/load",
      { sessionId, cwd: clean, mcpServers: mcp },
      oldBudgetMs,
    );
    const loadId = engine.nextId - 1;
    if (load) {
      out["load（旧 15s 预算内）"] = withLatency(load);
    } else {
      out["load（旧 15s 预算内）"] = `无响应（预算 ${seconds(oldBudgetMs)}）`;
      const deadline = Date.now() + wait(90_000);
      while (!engine.responses.has(loadId) && Date.now() < deadline) await sleep(100);
      out["load（实际返回）"] = withLatency(engine.settled(loadId));
    }
  } finally {
    engine.close();
  }
  return out;
}

async function scenarioHangDir(binary, work, wait) {
  const home = path.join(work, "home");
  const clean = path.join(work, "clean");
  const bad = path.join(work, "bad");
  const pluginDir = path.join(bad, ".opencode", "plugins");
  fs.mkdirSync(clean, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(here, "hang-plugin.js"), path.join(pluginDir, "hang.js"));
  const engine = await Engine.start(binary, { home, cwd: work });
  const out = {};
  try {
    await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(30_000));
    out["load（挂死目录）"] = withLatency(
      await engine.request(
        "session/load",
        { sessionId: "ses_doesnotexist0000000000000", cwd: bad, mcpServers: [] },
        wait(15_000),
      ),
    );
    out["new（同一挂死目录，模拟回退）"] = withLatency(
      await engine.request("session/new", { cwd: bad, mcpServers: [] }, wait(15_000)),
    );
    out["new（同进程的干净目录）"] = withLatency(
      await engine.request("session/new", { cwd: clean, mcpServers: [] }, wait(40_000)),
    );
    out["引擎进程仍存活"] = engine.child.exitCode === null;
    out["期间收到的通知数"] = engine.notifications;
    out["引擎日志尾部"] = engineLogTail(home);
  } finally {
    engine.close();
  }
  return out;
}

async function scenarioPluginRecovery(binary, work, wait) {
  const home = path.join(work, "home");
  const project = path.join(work, "project");
  const pluginDir = path.join(project, ".opencode", "plugins");
  fs.mkdirSync(project, { recursive: true });
  let engine;
  try {
    engine = await Engine.start(binary, { home, cwd: work, env: { OPENCODE_PURE: "0" } });
    await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(30_000));
    const created = await engine.request("session/new", { cwd: project, mcpServers: [] }, wait(40_000));
    const sessionId = created?.message.result?.sessionId;
    if (!sessionId) throw new Error("Could not create the original session");
    engine.close();

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.copyFileSync(path.join(here, "hang-plugin.js"), path.join(pluginDir, "hang.js"));
    fs.writeFileSync(path.join(project, ".opencode", "opencode.json"), JSON.stringify({
      permission: { bash: "deny" },
    }));
    const skillDir = path.join(project, ".opencode", "skills", "recovery-check");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: recovery-check\ndescription: Recovery probe skill\n---\n\nProbe.\n");
    engine = await Engine.start(binary, { home, cwd: work, env: { OPENCODE_PURE: "0" } });
    await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(30_000));
    const blocked = await engine.request("session/load", { sessionId, cwd: project, mcpServers: [] }, wait(15_000));
    if (blocked) throw new Error("Expected the external plugin to block session/load");
    engine.close();

    engine = await Engine.start(binary, { home, cwd: work, env: { OPENCODE_PURE: "1" } });
    await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(30_000));
    const restored = await engine.request("session/load", { sessionId, cwd: project, mcpServers: [] }, wait(40_000));
    if (!restored || restored.message.error || !restored.message.result) {
      throw new Error(`Could not restore original session: ${describe(restored)}`);
    }
    const query = `directory=${encodeURIComponent(project)}`;
    const configResponse = await fetch(`http://127.0.0.1:${engine.port}/config?${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!configResponse.ok) throw new Error(`Config query failed: ${configResponse.status}`);
    const config = await configResponse.json();
    if (config.permission?.bash !== "deny") throw new Error("Project permission was not preserved");
    const skillResponse = await fetch(`http://127.0.0.1:${engine.port}/skill?${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!skillResponse.ok) throw new Error(`Skill query failed: ${skillResponse.status}`);
    const skills = await skillResponse.json();
    if (!Array.isArray(skills) || !skills.some((skill) => skill.name === "recovery-check")) {
      throw new Error("Project skill was not preserved");
    }
    engine.close();
    engine = await Engine.start(binary, { home, cwd: project, env: { OPENCODE_PURE: "0" } });
    const blockedHandshake = await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(15_000));
    if (blockedHandshake) throw new Error("Expected the root plugin to block initialize");
    engine.close();
    engine = await Engine.start(binary, { home, cwd: project, env: { OPENCODE_PURE: "1" } });
    const recoveredHandshake = await engine.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, wait(30_000));
    if (!recoveredHandshake || recoveredHandshake.message.error || !recoveredHandshake.message.result) {
      throw new Error(`Could not recover handshake: ${describe(recoveredHandshake)}`);
    }
    return {
      "原会话": sessionId,
      "插件卡住时恢复": withLatency(blocked),
      "跳过外部插件后恢复同一会话": withLatency(restored),
      "插件文件仍在原处": fs.existsSync(path.join(pluginDir, "hang.js")),
      "项目权限和技能仍可见": true,
      "根目录插件阻塞握手": withLatency(blockedHandshake),
      "跳过插件后握手": withLatency(recoveredHandshake),
    };
  } finally {
    engine?.close();
  }
}

const SCENARIOS = { clean: scenarioClean, slowmcp: scenarioSlowMcp, hangdir: scenarioHangDir, "plugin-recovery": scenarioPluginRecovery };

async function main() {
  const [scenario, ...flags] = process.argv.slice(2);
  const fast = flags.includes("--fast");
  const wait = (ms) => (fast ? Math.round(ms / 5) : ms);
  if (!SCENARIOS[scenario]) {
    console.error(`用法: node probe.mjs <${Object.keys(SCENARIOS).join("|")}> [--fast]`);
    process.exit(2);
  }
  const binary = resolveEngineBinary();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `nuwax-session-setup-ha-${scenario}-`));
  console.log(
    `场景 ${scenario}${fast ? "（--fast，等待已缩短）" : ""}\n引擎 ${binary}\n工作目录 ${work}\n`,
  );
  try {
    print(`结论：${scenario}`, await SCENARIOS[scenario](binary, work, wait));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
