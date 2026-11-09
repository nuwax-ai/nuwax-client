import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WorkbenchMcp } from "../src/main/features/workbench/mcp";
import { createFeatureLifecycle } from "../src/main/features/_kit/lifecycle";
import type { FeatureContext, FeatureMcpServerEntry } from "../src/main/features/_kit/types";
import type { AgentSessionParticipant, AgentMcpServer } from "../src/main/features/_kit/agentSessions";
import { WORKBENCH_MCP } from "@shared/features/workbench/contract";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  let entry: FeatureMcpServerEntry | null = null;
  let factory!: () => AgentSessionParticipant;
  let allowed = true;
  const scope = { accountId: "one", origin: "https://fixture.example", epoch: 1 };
  const lifecycle = createFeatureLifecycle();
  const open = vi.fn(async (conversationId: string, _signal: AbortSignal) => ({ conversationId }));
  const command = vi.fn(async () => ({ tabs: [] }));
  const plugins = vi.fn(async (_operation: string, _input: unknown) => ({ bundles: [] }));
  const mcp = new WorkbenchMcp({
    product: "nuwax", log: { warn: vi.fn() }, lifecycle,
    session: { isAuthenticated: () => true }, platform: { scope: () => scope },
    agent: {
      registerSessionParticipant: value => { factory = value; return () => {}; },
      resolveNodeBinary: () => process.execPath,
      resolveConversationId: id => id === "native-one" ? "conversation-one" : id === "native-two" ? "conversation-two" : null,
      setLocalMcpServer: async (_name, value) => { entry = value; },
    },
  } as unknown as FeatureContext, { allowed: () => allowed, open, command, plugins });
  cleanup.push(() => mcp.dispose());
  await vi.waitFor(() => expect(entry).not.toBeNull());
  const connect = async (configuration: FeatureMcpServerEntry) => {
    const client = new Client({ name: "fixture", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: configuration.command, args: configuration.args,
      env: { ...process.env, ...configuration.env } as Record<string, string>, stderr: "ignore" }));
    cleanup.push(() => client.close());
    return client;
  };
  const session = async (nativeId: string) => {
    const participant = factory();
    cleanup.push(async () => participant.destroy());
    const servers: AgentMcpServer[] = [{ name: WORKBENCH_MCP }];
    participant.prepare(servers).bind(nativeId);
    participant.start(nativeId);
    const server = servers[0];
    const client = await connect({ command: server.command!, args: server.args!, env: Object.fromEntries(server.env!.map(row => [row.name, row.value])) });
    return { participant, client };
  };
  return { entry: entry!, connect, session, scope, open, command, plugins, deny: () => { allowed = false; mcp.revokeTurns(); } };
}

describe("workbench ACP authority", () => {
  it("routes layout presets through the owning conversation and rejects incomplete writes", async () => {
    const fixture = await setup();
    const { client } = await fixture.session("native-one");
    expect((await client.callTool({ name: "workbench_layout_preset", arguments: { action: "list" } })).isError).not.toBe(true);
    expect(fixture.command).toHaveBeenLastCalledWith("conversation-one", "preset", { action: "list" }, expect.any(AbortSignal));
    expect((await client.callTool({ name: "workbench_layout_preset", arguments: { action: "save", name: "Review" } })).isError).toBe(true);
    expect(fixture.command).toHaveBeenCalledTimes(1);
    const args = { action: "save", name: "Review", expectedRevision: null, expectedVersion: "11111111-1111-4111-8111-111111111111" };
    expect((await client.callTool({ name: "workbench_layout_preset", arguments: args })).isError).not.toBe(true);
    expect(fixture.command).toHaveBeenLastCalledWith("conversation-one", "preset", args, expect.any(AbortSignal));
    expect((await client.callTool({ name: "workbench_layout_preset", arguments: { ...args, sessionId: "another-session" } })).isError).toBe(true);
  });

  it("uses native revisioned configuration and revokes configuration calls when the turn ends", async () => {
    const fixture = await setup();
    const { client, participant } = await fixture.session("native-one");
    const args = { target: "third-party-settings", expectedRevision: 2, patch: { enabled: true } };
    expect((await client.callTool({ name: "workbench_plugin_configure", arguments: args })).isError).not.toBe(true);
    expect(fixture.plugins).toHaveBeenCalledWith("configure", args, expect.any(AbortSignal));
    participant.finish("native-one", 1, false);
    expect((await client.callTool({ name: "workbench_plugin_configure", arguments: args })).isError).toBe(true);
    expect(fixture.plugins).toHaveBeenCalledTimes(1);
  });
  it("binds each session transport to its host-owned conversation and rejects caller-supplied identity", async () => {
    const fixture = await setup();
    const first = await fixture.session("native-one"), second = await fixture.session("native-two");
    expect((await first.client.callTool({ name: "workbench_open", arguments: {} })).isError).not.toBe(true);
    expect((await second.client.callTool({ name: "workbench_open", arguments: {} })).isError).not.toBe(true);
    expect(fixture.open.mock.calls.map(call => call[0])).toEqual(["conversation-one", "conversation-two"]);
    expect((await first.client.callTool({ name: "workbench_open", arguments: { conversationId: "conversation-two" } })).isError).toBe(true);
    expect(fixture.open).toHaveBeenCalledTimes(2);
    const unknown = await fixture.session("unknown-native");
    expect((await unknown.client.callTool({ name: "workbench_open", arguments: {} })).isError).toBe(true);
  });

  it("allows catalog discovery while the shared proxy credential cannot control a workspace", async () => {
    const fixture = await setup();
    const client = await fixture.connect(fixture.entry);
    expect((await client.listTools()).tools.some(tool => tool.name === "workbench_open")).toBe(true);
    expect((await client.callTool({ name: "workbench_open", arguments: {} })).isError).toBe(true);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("revokes active connections on permission changes, completed turns and account generation changes", async () => {
    const fixture = await setup();
    const { participant, client } = await fixture.session("native-one");
    participant.finish("native-one", 1, false);
    expect((await client.callTool({ name: "workbench_open", arguments: {} })).isError).toBe(true);
    participant.start("native-one");
    expect((await client.callTool({ name: "workbench_open", arguments: {} })).isError).not.toBe(true);
    fixture.scope.epoch++;
    expect((await client.callTool({ name: "workbench_open", arguments: {} })).isError).toBe(true);
    fixture.scope.epoch--;
    fixture.deny();
    expect((await client.callTool({ name: "workbench_open", arguments: {} })).isError).toBe(true);
  });

  it("propagates prompt cancellation into in-flight workbench operations", async () => {
    const fixture = await setup();
    const { participant, client } = await fixture.session("native-one");
    fixture.open.mockImplementation(async (_conversationId, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
    }));
    const pending = client.callTool({ name: "workbench_open", arguments: {} });
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalled());
    participant.cancel("native-one");
    expect((await pending).isError).toBe(true);
  });
});
