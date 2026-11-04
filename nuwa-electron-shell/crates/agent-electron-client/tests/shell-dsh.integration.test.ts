import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { ShellCapabilitiesRuntime, getShellMcpEntry, subscribeShellMcp } from "../src/main/features/shell-capabilities";
import { ThemeService } from "../src/main/features/themes/service";
import { createFeatureLifecycle } from "../src/main/features/_kit/lifecycle";
import type { FeatureContext } from "../src/main/features/_kit/types";

// The DSH/DS-Bot/MCP/model loop is real. Only the remote model responses are
// deterministic; this test does not establish platform billing or packaged UI.
it("real DS-Bot discovers host tools, edits/applies/restores a personal theme and loses tools when access is revoked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-shell-dsh-"));
  const home = path.join(root, "dsh"); await fs.mkdir(path.join(home, "workspace"), { recursive: true });
  const history: Array<{ themeId: string; primary?: string }> = [];
  let themes: ThemeService;
  themes = new ThemeService(path.join(root, "themes"), { fs, watch: () => () => {}, systemDark: () => false, applyPreference: () => {},
    changed: () => { const snapshot = themes.state().snapshot; history.push({ themeId: snapshot.themeId, primary: snapshot.tokens.primary }); } });
  await themes.ready;
  const settings = new Map<string, unknown>();
  const runtime = new ShellCapabilitiesRuntime({ product: "nuwax", hostIpc: { handle: () => {}, dispose: () => {} },
    lifecycle: createFeatureLifecycle(), session: { isAuthenticated: () => true },
    platform: { scope: () => ({ accountId: "fixture", origin: "https://fixture.example", epoch: 1 }) },
    settings: { read: key => settings.get(key), write: (key, value) => { settings.set(key, value); return true; } },
    agent: { resolveNodeBinary: () => process.execPath, setLocalMcpServer: async () => {} }, log: { warn: () => {} },
  } as unknown as FeatureContext, { themes: () => themes });
  let child: ChildProcess | undefined, cookie = "", origin = "", output = "";
  const calls: string[] = [], failure: string[] = [];
  let revokedCatalog = false;
  const decode = (content: any): any => {
    if (typeof content === "string") { try { return decode(JSON.parse(content)); } catch { return content; } }
    if (Array.isArray(content)) return decode(content.find(item => item.type === "text")?.text);
    if (content?.content) return decode(content.content);
    return content;
  };
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const index = body.messages.findLastIndex((message: any) => message.role === "user" && JSON.stringify(message.content).includes("[integration:"));
      const user = JSON.stringify(body.messages[index]?.content);
      const results = body.messages.slice(index + 1).filter((message: any) => message.role === "tool").map((message: any) => decode(message.content));
      const steps = ["themes_context", "themes_read_files", "themes_copy", "themes_read_files", "themes_apply_changes", "themes_select", "themes_history", "themes_read_files", "themes_rollback"];
      let name = steps[results.length], args: any = {}, final = "SHELL_THEME_DONE";
      if (user.includes("[integration:revoked]")) {
        revokedCatalog = !body.tools?.some((tool: any) => tool.function.name.startsWith("mcp__nuwax-shell__"));
        name = undefined!; final = "NO_SHELL_ACCESS";
      }
      if (name === "themes_read_files") args = { themeId: results.length === 1 ? "nuwax-default" : "agent-forest" };
      if (name === "themes_copy") args = { sourceId: "nuwax-default", themeId: "agent-forest", name: "Forest", expectedRevision: results[1].revision, expectedVersion: results[1].version };
      if (name === "themes_apply_changes") {
        const read = results[3], manifest = JSON.parse(read.files.find((file: any) => file.path === "theme.json").content);
        args = { themeId: "agent-forest", expectedRevision: read.revision, expectedVersion: read.version,
          changes: [{ path: manifest.variants.dark.tokens, content: JSON.stringify({ primary: "#23755a" }) }] };
      }
      if (name === "themes_select") args = { themeId: "agent-forest", mode: "dark", expectedRevision: results[4].state.revision };
      if (name === "themes_rollback") args = { historyId: results[6].history[0].id, expectedRevision: results[7].revision, expectedVersion: results[7].version };
      const publicName = name ? `mcp__nuwax-shell__${name}` : undefined;
      if (publicName && !body.tools?.some((tool: any) => tool.function.name === publicName)) throw new Error(`Missing native DSH tool ${publicName}`);
      if (publicName) calls.push(name);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (delta: unknown, finish_reason: string | null = null) => "data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
      res.write(event({ role: "assistant" }));
      res.write(event(publicName ? { tool_calls: [{ index: 0, id: "shell_" + calls.length, type: "function", function: { name: publicName, arguments: JSON.stringify(args) } }] } : { content: final }));
      res.write(event({}, publicName ? "tool_calls" : "stop")); res.end("data: [DONE]\n\n");
    } catch (error) { failure.push(String(error)); res.writeHead(500); res.end("Fixture failed"); }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const dshRoot = path.resolve(__dirname, "../../dsh-runtime");
  const { createModelBroker } = await import(/* @vite-ignore */ pathToFileURL(path.join(dshRoot, "model-broker.mjs")).href);
  const models = [{ id: "1", provider: "nuwax-1", name: "Fixture", model: "mock", api: "openai-completions", contextWindow: 128000, maxTokens: 8192, input: ["text"] }];
  const broker = createModelBroker({ models, baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, apiKey: "fixture-only", current: () => true, port: 0 });
  const brokerUrl = await broker.start();
  const off = subscribeShellMcp(() => { if (child?.connected) child.send({ type: "shell-mcp", entry: getShellMcpEntry() }); });
  const api = async (endpoint: string, payload: unknown = {}) => {
    const response = await fetch(origin + "/api/bot", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(15000) });
    const body = await response.json(); if (!body.ok) throw new Error(JSON.stringify(body)); return body.value;
  };
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) { if (failure.length) throw new Error(failure.join("\n")); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`DS-Bot theme loop timed out; calls=${JSON.stringify(calls)}; ${output.slice(-4000)}`);
  };
  try {
    await runtime.setAccess({ themes: true, settings: false, extensions: false });
    await fs.writeFile(path.join(home, "launch.json"), JSON.stringify({ models, workspace: path.join(home, "workspace"), port: 0, shellMcp: getShellMcpEntry() }));
    child = fork(path.join(dshRoot, "host.mjs"), [], { env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, NUWAX_DSH_SCOPE_ROOT: home,
      NUWAX_DSH_BROKER: brokerUrl, NUWAX_DSH_RUN_TOKEN: broker.token, NUWAX_DSH_REQUIRE_OFFICE: "0", DSH_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout?.on("data", data => { output = (output + data).slice(-12000); }); child.stderr?.on("data", data => { output = (output + data).slice(-12000); });
    const ready = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DSH startup timed out: " + output)), 45000);
      child!.on("message", (message: any) => {
        if (message.type === "ready") { clearTimeout(timer); resolve(message); }
        if (message.type === "failed") { clearTimeout(timer); reject(new Error(message.error + "\n" + output)); }
      });
      child!.once("exit", () => { clearTimeout(timer); reject(new Error("DSH exited: " + output)); });
    });
    const first = await fetch(ready.url, { redirect: "manual" }); cookie = first.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); await first.body?.cancel(); origin = new URL(ready.url).origin;
    const state = await api("state"), botId = state.mainBotId;
    await api("send", { sessionId: botId, text: "[integration:shell-theme] Create, apply and restore a personal forest theme." });
    await until(async () => JSON.stringify(await api("chat", { botId })).includes("SHELL_THEME_DONE"));
    expect(calls).toEqual(["themes_context", "themes_read_files", "themes_copy", "themes_read_files", "themes_apply_changes", "themes_select", "themes_history", "themes_read_files", "themes_rollback"]);
    expect(history.some(row => row.themeId === "agent-forest" && row.primary === "#23755a")).toBe(true);
    expect(themes.state().selection.themeId).toBe("nuwax-default");
    const disconnected = new Promise<void>(resolve => { child!.on("message", (message: any) => { if (message.type === "shell-mcp-state" && !message.ready) resolve(); }); });
    await runtime.setAccess({ themes: false, settings: false, extensions: false }); await disconnected;
    await api("send", { sessionId: botId, text: "[integration:revoked] Check that host capabilities are absent." });
    await until(async () => JSON.stringify(await api("chat", { botId })).includes("NO_SHELL_ACCESS"));
    expect(revokedCatalog).toBe(true);
  } finally {
    off();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
      child.send({ type: "stop" }); const timer = setTimeout(() => child!.kill("SIGKILL"), 5000); await exited; clearTimeout(timer);
    }
    await runtime.dispose(); await themes.dispose(); await broker.close();
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 100000);
