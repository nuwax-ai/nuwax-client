import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ShellCapabilitiesRuntime, getShellMcpEntry } from "../src/main/features/shell-capabilities";
import { ThemeService, themeAuthoringContext } from "../src/main/features/themes/service";
import { createFeatureLifecycle } from "../src/main/features/_kit/lifecycle";
import { createTrustedIpc } from "../src/main/features/_kit/trustedIpc";
import type { FeatureContext } from "../src/main/features/_kit/types";
import { SHELL_CAPABILITIES_IPC } from "@shared/features/shell-capabilities/contract";
import { BROWSER_SETTING, linkOpenMode } from "@shared/features/browser/contract";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-cap-test-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const themes = new ThemeService(directory, { fs, watch: () => () => {}, systemDark: () => false, applyPreference: () => {}, changed: () => {} });
  cleanup.push(() => themes.dispose()); await themes.ready;
  const settings = new Map<string, unknown>(), handlers = new Map<string, (...args: any[]) => any>();
  const ipc = { handle: (key: string, run: (...args: any[]) => any) => handlers.set(key, run), removeHandler: (key: string) => handlers.delete(key) };
  const lifecycle = createFeatureLifecycle();
  let authenticated = true;
  const identity = { accountId: "test", origin: "https://test.example", epoch: 1 };
  const agent = { resolveNodeBinary: () => process.execPath, setLocalMcpServer: vi.fn(async () => {}), hasLocalMcpServer: () => false };
  const plugins = vi.fn(async () => ({ bundles: [] }));
  const runtime = new ShellCapabilitiesRuntime({ product: "nuwax", settings: { read: key => settings.get(key), write: (key, value) => { settings.set(key, value); return true; } },
    agent, session: { isAuthenticated: () => authenticated }, platform: { scope: () => authenticated ? identity : null },
    hostIpc: createTrustedIpc(ipc, (event: any) => event.trusted === true), lifecycle, log: { warn: vi.fn() },
  } as unknown as FeatureContext, { themes: () => themes, themeAuthoring: themeAuthoringContext, linkPreference: { key: BROWSER_SETTING, normalize: linkOpenMode }, plugins });
  cleanup.push(() => runtime.dispose());
  const connect = async () => {
    const entry = getShellMcpEntry(); expect(entry).not.toBeNull();
    const transport = new StdioClientTransport({ ...entry!, stderr: "pipe" });
    const client = new Client({ name: "integration-test", version: "1" }, { capabilities: {} });
    cleanup.push(() => client.close());
    transport.stderr?.resume();
    await client.connect(transport);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, value: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  };
  return { runtime, themes, agent, lifecycle, settings, identity, handlers, connect, call, plugins,
    logout: () => { authenticated = false; lifecycle.emitSessionInvalidated(); } };
}
describe("shell capabilities over the actual MCP stdio connection", () => {
  it("defaults off, rejects untrusted permission changes and exposes only authorized tools", async () => {
    const { runtime, handlers, connect } = await setup();
    expect(runtime.state().ready).toBe(false);
    expect(await handlers.get(SHELL_CAPABILITIES_IPC)!({ trusted: false }, "access", { themes: true, settings: true, extensions: true })).toBeNull();
    expect(runtime.state().access).toEqual({ themes: false, settings: false, extensions: false });
    await runtime.setAccess({ themes: true, settings: false, extensions: false });
    const client = await connect(), tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain("themes_apply_changes");
    expect(tools.tools.some(tool => tool.name.startsWith("extensions_") || tool.name.startsWith("shell_settings_"))).toBe(false);
    expect(runtime.state().ready).toBe(true);
  });
  it("creates a personal theme, edits real files, applies appearance and restores the saved files through MCP", async () => {
    const { runtime, themes, connect, call } = await setup();
    await runtime.setAccess({ themes: true, settings: false, extensions: false });
    const client = await connect();
    const source = (await call(client, "themes_read_files", { themeId: "deepseek-inspired" })).value;
    const copied = await call(client, "themes_copy", { sourceId: source.themeId, themeId: "agent-theme", name: "Agent Theme", expectedRevision: source.revision, expectedVersion: source.version });
    expect(copied.error).toBe(false);
    const current = (await call(client, "themes_read_files", { themeId: "agent-theme" })).value;
    const manifest = JSON.parse(current.files.find((file: any) => file.path === "theme.json").content);
    const target = manifest.variants.dark.tokens;
    const request = { themeId: "agent-theme", expectedRevision: current.revision, expectedVersion: current.version, changes: [{ path: target, content: JSON.stringify({ primary: "#23755a" }) }] };
    expect((await call(client, "themes_validate", request)).value.valid).toBe(true);
    const changed = await call(client, "themes_apply_changes", request);
    expect(changed.error).toBe(false);
    expect((await call(client, "themes_select", { themeId: "agent-theme", mode: "dark", expectedRevision: changed.value.state.revision })).error).toBe(false);
    expect(themes.state().snapshot.tokens.primary).toBe("#23755a");
    expect(runtime.state().changes.some(change => change.operation === "themes_apply_changes" && change.status === "applied")).toBe(true);
    expect(JSON.stringify(runtime.state().changes)).not.toContain("#23755a");
    expect(await fs.readFile(path.join(themes.directory, "installed/agent-theme", target), "utf8")).toContain("#23755a");
    const edited = (await call(client, "themes_read_files", { themeId: "agent-theme" })).value;
    const history = (await call(client, "themes_history")).value;
    expect((await call(client, "themes_rollback", { historyId: history.history[0].id, expectedRevision: edited.revision, expectedVersion: edited.version })).error).toBe(false);
    expect(await themes.exportPackage("agent-theme")).toEqual(Object.fromEntries(current.files.map((file: any) => [file.path, file.encoding === "utf8" ? Buffer.from(file.content).toString("base64") : file.content])));
  });
  it("revokes existing connections when scopes change and on logout, rotating the connection secret", async () => {
    const { runtime, connect, logout } = await setup();
    await runtime.setAccess({ themes: true, settings: false, extensions: false });
    const original = getShellMcpEntry(), client = await connect();
    await runtime.setAccess({ themes: false, settings: true, extensions: false });
    await expect(client.callTool({ name: "themes_context", arguments: {} })).rejects.toThrow();
    expect(getShellMcpEntry()?.env).not.toEqual(original?.env);
    const next = await connect();
    expect((await next.listTools()).tools.map(tool => tool.name)).toEqual(["shell_capabilities", "shell_settings_get", "shell_settings_update"]);
    logout();
    expect(getShellMcpEntry()).toBeNull();
    expect(runtime.state().ready).toBe(false);
    await expect(next.callTool({ name: "shell_settings_get", arguments: {} })).rejects.toThrow();
  });
  it("uses version checks for declared settings and delegates plugin operations only with their separate permission", async () => {
    const { runtime, settings, plugins, connect, call } = await setup();
    await runtime.setAccess({ themes: false, settings: true, extensions: true });
    const client = await connect(), current = (await call(client, "shell_settings_get")).value;
    expect((await call(client, "shell_settings_update", { expectedVersion: current.version, linkOpenMode: "system" })).value.applied).toBe(true);
    expect(settings.get(BROWSER_SETTING)).toBe("system");
    const stale = await client.callTool({ name: "shell_settings_update", arguments: { expectedVersion: current.version, linkOpenMode: "in-app" } });
    expect(stale.isError).toBe(true);
    expect((await call(client, "extensions_list")).error).toBe(false);
    expect(plugins).toHaveBeenCalledWith("list", {}, expect.any(AbortSignal));
  });
  it("does not carry another account's permissions or operation history into the current session", async () => {
    const { runtime, identity, lifecycle, connect, call } = await setup();
    await runtime.setAccess({ themes: false, settings: true, extensions: false });
    const client = await connect(), current = (await call(client, "shell_settings_get")).value;
    await call(client, "shell_settings_update", { expectedVersion: current.version, linkOpenMode: "system" });
    expect(runtime.state().changes).toHaveLength(1);
    lifecycle.emitSessionInvalidated(); identity.accountId = "another"; identity.epoch++;
    await lifecycle.emitServicesStarting(new AbortController().signal);
    expect(runtime.state()).toMatchObject({ ready: false, access: { themes: false, settings: false, extensions: false }, changes: [] });
    expect(getShellMcpEntry()).toBeNull();
  });
});
