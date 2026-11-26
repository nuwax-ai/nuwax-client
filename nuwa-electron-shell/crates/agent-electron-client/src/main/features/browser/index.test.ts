import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_AGENT_ENABLED_SETTING } from "@shared/features/browser/contract";
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
  listAgentTabs: vi.fn((sessionKey: string) => ({
    windowId: `fixture-${sessionKey}`,
    tabs: [],
  })),
  resolveAgentPage: vi.fn(() => null),
  activateAgentPage: vi.fn(() => false),
  refresh: vi.fn(),
}));
vi.mock("./windows", () => ({ createBrowserWindows: mocks.create }));
import {
  browserFeature,
  createDesktopBrowserPage,
  isDesktopBrowserAvailable,
  refreshDesktopBrowserAgentPreference,
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
    listAgentTabs: mocks.listAgentTabs,
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
  it("requires opt-in, revokes live grants on opt-out and isolates participant cleanup", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nuwax-browser-agent-"),
    );
    let optedIn: boolean | undefined;
    let hasMcpEntry = true; // A previous version may have registered it by default.
    const setLocalMcpServer = vi.fn(async (_name: string, entry: unknown) => {
      hasMcpEntry = entry !== null;
    });
    let factory: (() => AgentSessionParticipant) | null = null;
    const ctx = {
      ...context(),
      settings: {
        read: vi.fn((key: string) => key === BROWSER_AGENT_ENABLED_SETTING ? optedIn : undefined),
        write: vi.fn(() => true),
      },
      log: { info() {}, warn() {}, error() {} },
      windows: { getMain: () => null },
      activities: { set: vi.fn() },
      dataDir: directory,
      scratch: { create: vi.fn(() => directory), remove: vi.fn(), sweep: vi.fn() },
      agent: {
        resolveNodeBinary: () => process.execPath,
        setLocalMcpServer,
        hasLocalMcpServer: () => hasMcpEntry,
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
      expect(isDesktopBrowserAvailable()).toBe(true);
      await vi.waitFor(() => expect(setLocalMcpServer).toHaveBeenCalledWith("nuwax-browser", null));
      expect(setLocalMcpServer).toHaveBeenCalledOnce();
      expect(ctx.scratch.create).not.toHaveBeenCalled();
      expect(factory).toBeTypeOf("function");
      const participant = (factory as unknown as () => AgentSessionParticipant)();
      const defaultServers = [{ name: "nuwax-browser" }, { name: "other-browser" }];
      participant.prepare(defaultServers).bind("default");
      expect(defaultServers).toEqual([{ name: "other-browser" }]);
      expect(participant.start("default")).toBe(0);

      optedIn = true;
      await refreshDesktopBrowserAgentPreference();
      await vi.waitFor(() =>
        expect(setLocalMcpServer).toHaveBeenCalledWith(
          "nuwax-browser",
          expect.objectContaining({ command: process.execPath }),
        ),
      );
      expect(browserFeature.agentServers).toEqual(["nuwax-browser"]);
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
      // Two independent engines can return the same ACP session ID.
      otherPrepared.bind("session-3");
      const otherFile = Object.fromEntries(
        (otherServers[0]?.env ?? []).map((item) => [item.name, item.value]),
      ).NUWAX_BROWSER_SESSION!;
      expect(fs.existsSync(otherFile)).toBe(true);
      const listWindow = async (file: string) => {
        const relay = mcpClient(Number(env.NUWAX_BROWSER_PORT));
        try {
          await relay.opened;
          relay.send({ token, grant: fs.readFileSync(file, "utf8") });
          relay.send({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "nuwax_browser_list_tabs", arguments: {} },
          });
          return (await relay.next()).result.structuredContent.windowId;
        } finally {
          relay.socket.destroy();
        }
      };
      participant.start("session-3");
      const firstWindow = await listWindow(freshFile);
      expect(firstWindow).toBeTypeOf("string");
      participant.destroy();
      expect(fs.existsSync(freshFile)).toBe(false);
      expect(fs.existsSync(otherFile)).toBe(true);

      const activeRelay = mcpClient(Number(env.NUWAX_BROWSER_PORT));
      try {
        await activeRelay.opened;
        activeRelay.send({ token, grant: fs.readFileSync(otherFile, "utf8") });
        expect(other.start("session-3")).toBe(1);
        const list = (id: number) => {
          activeRelay.send({
            jsonrpc: "2.0", id, method: "tools/call",
            params: { name: "nuwax_browser_list_tabs", arguments: {} },
          });
          return activeRelay.next();
        };
        const otherWindow = (await list(1)).result.structuredContent.windowId;
        expect(otherWindow).toBeTypeOf("string");
        expect(otherWindow).not.toBe(firstWindow);
        optedIn = false;
        const removal = refreshDesktopBrowserAgentPreference();
        expect(fs.existsSync(otherFile)).toBe(false);
        expect(other.start("session-3")).toBe(0);
        expect((await list(2)).error.message).toBe("notAuthorized");
        await removal;
        expect(setLocalMcpServer).toHaveBeenLastCalledWith("nuwax-browser", null);
        expect(isDesktopBrowserAvailable()).toBe(true);
        expect(mocks.closeAll).not.toHaveBeenCalled();

        optedIn = true;
        await refreshDesktopBrowserAgentPreference();
        expect(other.start("session-3")).toBe(0);
        expect((await list(3)).error.message).toBe("notAuthorized");
        const reopenedServers: Parameters<AgentSessionParticipant["prepare"]>[0] = [];
        other.prepare(reopenedServers).bind("session-3");
        expect(reopenedServers).toHaveLength(1);
        expect(other.start("session-3")).toBe(1);
      } finally {
        activeRelay.socket.destroy();
      }
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
