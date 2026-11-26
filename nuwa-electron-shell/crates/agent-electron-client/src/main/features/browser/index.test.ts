import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionParticipant } from "../_kit/agentSessions";
import { registerDesktopFeatures } from "../_kit/register";
import type { FeatureContext, FeatureHandle } from "../_kit/types";
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  closeAll: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
  configureAgent: vi.fn(),
  listAgentPages: vi.fn(() => []),
  resolveAgentPage: vi.fn(() => null),
  activateAgentPage: vi.fn(() => false),
  refresh: vi.fn(),
}));
vi.mock("./windows", () => ({ createBrowserWindows: mocks.create }));
import {
  browserFeature,
  createDesktopBrowserPage,
  isDesktopBrowserAvailable,
} from "./index";
function mcpClient(port: number) {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  let buffer = "";
  const queued: Array<Record<string, any>> = [];
  const waiting: Array<(value: Record<string, any>) => void> = [];
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line) as Record<string, any>;
      const waiter = waiting.shift();
      if (waiter) waiter(value);
      else queued.push(value);
    }
  });
  const next = () =>
    new Promise<Record<string, any>>((resolve) => {
      const value = queued.shift();
      if (value) resolve(value);
      else waiting.push(resolve);
    });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return {
    socket,
    opened,
    next,
    send: (value: unknown) => socket.write(JSON.stringify(value) + "\n"),
  };
}

let handle: FeatureHandle | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue({
    open: mocks.open,
    closeAll: mocks.closeAll,
    dispose: mocks.dispose,
    configureAgent: mocks.configureAgent,
    listAgentPages: mocks.listAgentPages,
    resolveAgentPage: mocks.resolveAgentPage,
    activateAgentPage: mocks.activateAgentPage,
    refresh: mocks.refresh,
  });
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
});
const context = () => ({
  settings: { read: vi.fn() },
  ipc: { handle: vi.fn(), dispose: vi.fn() },
  hostIpc: { handle: vi.fn(), dispose: vi.fn() },
  lifecycle: { onSessionEnd: vi.fn((_listener: () => void) => vi.fn()) },
});
describe("browser feature lifecycle", () => {
  it.each(["disabled", "other-product"])(
    "does not construct a context or browser runtime when %s",
    (mode) => {
      const createContext = vi.fn();
      const registered = registerDesktopFeatures([browserFeature], {
        product: mode === "other-product" ? "nuwaclaw" : "nuwax",
        isEnabled: () => mode !== "disabled",
        createContext,
        log: { info() {}, warn() {}, error() {} },
      });
      expect(registered.ids).toEqual([]);
      expect(createContext).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(isDesktopBrowserAvailable()).toBe(false);
    }
  );
  it("registers capabilities without opening a page, revokes on disable, and disposes resources", () => {
    const ctx = context();
    handle = browserFeature.register(ctx as unknown as FeatureContext);
    expect(isDesktopBrowserAvailable()).toBe(true);
    expect(mocks.open).not.toHaveBeenCalled();
    const end = ctx.lifecycle.onSessionEnd.mock
      .calls[0][0] as unknown as () => void;
    end();
    expect(mocks.closeAll).toHaveBeenCalledOnce();
    ctx.settings.read.mockReturnValue(false);
    expect(isDesktopBrowserAvailable()).toBe(false);
    expect(createDesktopBrowserPage({ windowOptions: {} })).toBeNull();
    handle.dispose();
    handle = undefined;
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(isDesktopBrowserAvailable()).toBe(false);
  });
  it("registers a per-turn session grant and isolates participant cleanup", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nuwax-browser-agent-"),
    );
    const setLocalMcpServer = vi.fn(async () => {});
    let factory: (() => AgentSessionParticipant) | null = null;
    const ctx = {
      ...context(),
      settings: { read: vi.fn(() => true), write: vi.fn(() => true) },
      log: { info() {}, warn() {}, error() {} },
      windows: { getMain: () => null },
      activities: { set: vi.fn() },
      dataDir: directory,
      scratch: { create: () => directory, remove: vi.fn(), sweep: vi.fn() },
      agent: {
        resolveNodeBinary: () => process.execPath,
        setLocalMcpServer,
        hasLocalMcpServer: () => true,
        registerSessionParticipant: (
          next: () => AgentSessionParticipant,
        ) => {
          factory = next;
          return vi.fn();
        },
        resolveConversationId: () => "conversation-9",
      },
      lifecycle: {
        onSessionEnd: vi.fn(() => vi.fn()),
        onSessionInvalidated: vi.fn(() => vi.fn()),
        onServicesStopping: vi.fn(() => vi.fn()),
        onQuit: vi.fn(() => vi.fn()),
      },
    };
    const local = browserFeature.register(ctx as unknown as FeatureContext);
    try {
      await vi.waitFor(() =>
        expect(setLocalMcpServer).toHaveBeenCalledWith(
          "nuwax-browser",
          expect.objectContaining({ command: process.execPath }),
        ),
      );
      expect(browserFeature.agentServers).toEqual(["nuwax-browser"]);
      expect(factory).toBeTypeOf("function");
      const participant = (factory as unknown as () => AgentSessionParticipant)();
      const servers: Array<{
        name: string;
        command?: string;
        args?: string[];
        env?: Array<{ name: string; value: string }>;
      }> = [];
      const prepared = participant.prepare(servers);
      expect(servers.map((server) => server.name)).toEqual(["nuwax-browser"]);
      const env = Object.fromEntries(
        (servers[0]?.env ?? []).map((item) => [item.name, item.value]),
      );
      expect(env.NUWAX_BROWSER_KEY).toBe(path.join(directory, "key"));
      const grantFile = env.NUWAX_BROWSER_SESSION!;
      expect(fs.existsSync(grantFile)).toBe(true);
      prepared.bind("session-1");
      const token = fs.readFileSync(env.NUWAX_BROWSER_KEY!, "utf8");
      const client = mcpClient(Number(env.NUWAX_BROWSER_PORT));
      await client.opened;
      client.send({ token, grant: fs.readFileSync(grantFile, "utf8") });
      const callObserve = (id: number) => {
        client.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "nuwax_browser_observe", arguments: {} },
        });
        return client.next();
      };

      // A session transport may connect before the first turn, but cannot act.
      expect((await callObserve(1)).error.message).toBe("notAuthorized");
      expect(participant.start("session-1")).toBe(1);
      const active = await callObserve(2);
      expect(active.result.isError).toBe(true);
      expect(active.result.structuredContent.code).toBe("noAuthorization");
      // Finish revokes the turn; the same transport is refused immediately.
      participant.finish("session-1", 1);
      expect((await callObserve(3)).error.message).toBe("notAuthorized");
      // The next turn uses a new owner generation and is active again.
      expect(participant.start("session-1")).toBe(2);
      expect((await callObserve(4)).result.structuredContent.code).toBe(
        "noAuthorization",
      );
      participant.finish("session-1", 2);
      participant.remove("session-1");
      expect(fs.existsSync(grantFile)).toBe(false);
      client.socket.destroy();

      // Destroying one participant must not release another participant's grant.
      const freshServers: Array<{
        name: string;
        command?: string;
        args?: string[];
        env?: Array<{ name: string; value: string }>;
      }> = [];
      const fresh = participant.prepare(freshServers);
      fresh.bind("session-3");
      const freshFile = Object.fromEntries(
        (freshServers[0]?.env ?? []).map((item) => [item.name, item.value]),
      ).NUWAX_BROWSER_SESSION!;
      expect(fs.existsSync(freshFile)).toBe(true);
      const other = (factory as unknown as () => AgentSessionParticipant)();
      const otherServers: Array<{
        name: string;
        command?: string;
        args?: string[];
        env?: Array<{ name: string; value: string }>;
      }> = [];
      const otherPrepared = other.prepare(otherServers);
      otherPrepared.bind("session-2");
      const otherFile = Object.fromEntries(
        (otherServers[0]?.env ?? []).map((item) => [item.name, item.value]),
      ).NUWAX_BROWSER_SESSION!;
      expect(fs.existsSync(otherFile)).toBe(true);
      participant.destroy();
      expect(fs.existsSync(freshFile)).toBe(false);
      expect(fs.existsSync(otherFile)).toBe(true);
      other.destroy();
      expect(fs.existsSync(otherFile)).toBe(false);
    } finally {
      local.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a failed registration leaves no browser capability and releases the runtime", () => {
    const ctx = context();
    ctx.hostIpc.handle.mockImplementation(() => {
      throw new Error("registration failure");
    });
    const registered = registerDesktopFeatures([browserFeature], {
      product: "nuwax",
      isEnabled: () => true,
      createContext: () => ctx as unknown as FeatureContext,
      log: { info() {}, warn() {}, error() {} },
    });
    expect(registered.ids).toEqual([]);
    expect(isDesktopBrowserAvailable()).toBe(false);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
