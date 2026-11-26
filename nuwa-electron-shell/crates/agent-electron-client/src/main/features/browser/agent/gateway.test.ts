import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AgentBrowserError } from "./errors";
import { BrowserGateway, type BrowserGrantRecord } from "./gateway";

function client(port: number) {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  let buffer = "";
  const queued: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line) as unknown;
      const waiter = waiting.shift();
      if (waiter) waiter(value);
      else queued.push(value);
    }
  });
  const next = () =>
    new Promise<Record<string, any>>((resolve) => {
      const value = queued.shift();
      if (value !== undefined) resolve(value as Record<string, any>);
      else waiting.push((item) => resolve(item as Record<string, any>));
    });
  const send = (value: unknown) =>
    socket.write(JSON.stringify(value) + "\n");
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  return { socket, opened, closed, send, next };
}

function setup(
  grants: Record<string, BrowserGrantRecord>,
  call: (input: {
    owner: string;
    conversationId: string | null;
    tool: string;
    args: unknown;
    signal: AbortSignal;
  }) => Promise<{ text: string; structured: Record<string, unknown>; image?: { mimeType: string; data: string } }>,
) {
  const cancel = vi.fn();
  const disconnect = vi.fn();
  const gateway = new BrowserGateway({
    owner: (grant) => grants[grant],
    call,
    cancel,
    disconnect,
  });
  return { gateway, cancel, disconnect };
}

describe("BrowserGateway authentication", () => {
  it("rejects a wrong token and keeps the engine out", async () => {
    const call = vi.fn();
    const { gateway } = setup({}, call);
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "wrong" });
    await connection.closed;
    expect(call).not.toHaveBeenCalled();
    gateway.close();
  });

  it("rejects an unknown session grant", async () => {
    const call = vi.fn();
    const { gateway } = setup({}, call);
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct", grant: "unknown" });
    await connection.closed;
    gateway.close();
  });

  it("lists tools without a grant but refuses every action", async () => {
    const call = vi.fn();
    const { gateway } = setup({}, call);
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct" });
    connection.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const initialize = await connection.next();
    expect(initialize.result.serverInfo.name).toBe("nuwax-browser");
    connection.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = await connection.next();
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "nuwax_browser_observe",
    );
    const observe = tools.result.tools.find(
      (tool: { name: string }) => tool.name === "nuwax_browser_observe",
    );
    expect(observe.inputSchema.properties.screenshot).toMatchObject({
      type: "boolean",
    });
    expect(observe.description).toContain("structuredContent.outline");
    expect(observe.description.toLowerCase()).toContain("never guess");
    connection.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nuwax_browser_observe", arguments: {} },
    });
    const denied = await connection.next();
    expect(denied.error.message).toBe("notAuthorized");
    expect(call).not.toHaveBeenCalled();
    connection.socket.destroy();
    gateway.close();
  });
});

describe("BrowserGateway session binding", () => {
  it("passes the grant owner to the controller and returns tool content", async () => {
    const call = vi.fn(async () => ({
      text: "Observed",
      structured: { observationId: "obs-1" },
      image: { mimeType: "image/png", data: "cG5n" },
    }));
    const { gateway, disconnect } = setup(
      { g1: { owner: "session-a", conversationId: "conv-1", active: true } },
      call,
    );
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct", grant: "g1" });
    connection.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "nuwax_browser_observe", arguments: {} },
    });
    const reply = await connection.next();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "session-a",
        conversationId: "conv-1",
        tool: "nuwax_browser_observe",
      }),
    );
    expect(reply.result.isError).toBe(false);
    expect(reply.result.structuredContent).toEqual({ observationId: "obs-1" });
    expect(reply.result.content[0]).toEqual({ type: "text", text: "Observed" });
    expect(reply.result.content[1]).toEqual({
      type: "image",
      data: "cG5n",
      mimeType: "image/png",
    });

    connection.socket.destroy();
    await connection.closed;
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledWith("g1"),
    );
    gateway.close();
  });

  it("aborts a pending action on a cancellation notification", async () => {
    let seen: AbortSignal | null = null;
    const call = vi.fn(
      async ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          seen = signal;
          signal.addEventListener("abort", () =>
            reject(new AgentBrowserError("cancelled", "cancelled")),
          );
        }),
    );
    const { gateway, cancel } = setup(
      { g1: { owner: "session-a", conversationId: null, active: true } },
      call,
    );
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct", grant: "g1" });
    connection.send({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "nuwax_browser_click", arguments: {} },
    });
    connection.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 11 },
    });
    const reply = await connection.next();
    expect(cancel).toHaveBeenCalledWith("session-a");
    expect(seen?.aborted).toBe(true);
    expect(reply.result.structuredContent).toEqual({
      code: "cancelled",
      uncertain: false,
    });
    connection.socket.destroy();
    gateway.close();
  });

  it("reports uncertain outcomes as uncertain", async () => {
    const call = vi.fn(async () => {
      throw new AgentBrowserError("uncertain", "may have run", true);
    });
    const { gateway } = setup(
      { g1: { owner: "session-a", conversationId: null, active: true } },
      call,
    );
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct", grant: "g1" });
    connection.send({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "nuwax_browser_click", arguments: {} },
    });
    const reply = await connection.next();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.structuredContent).toEqual({
      code: "uncertain",
      uncertain: true,
    });
    connection.socket.destroy();
    gateway.close();
  });
});

describe("BrowserGateway turn and transport lifecycle", () => {
  it("refuses a valid grant outside its active turn", async () => {
    const call = vi.fn(async () => ({
      text: "ok",
      structured: { ok: true },
    }));
    const grants = {
      g1: { owner: "session-a", conversationId: null, active: false },
    };
    const { gateway } = setup(grants, call);
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct", grant: "g1" });
    connection.send({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "nuwax_browser_observe", arguments: {} },
    });
    const refused = await connection.next();
    expect(refused.error.message).toBe("notAuthorized");
    expect(call).not.toHaveBeenCalled();

    grants.g1.active = true;
    connection.send({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "nuwax_browser_observe", arguments: {} },
    });
    const allowed = await connection.next();
    expect(allowed.result.isError).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);

    grants.g1.active = false;
    connection.send({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "nuwax_browser_observe", arguments: {} },
    });
    const late = await connection.next();
    expect(late.error.message).toBe("notAuthorized");
    expect(call).toHaveBeenCalledTimes(1);
    connection.socket.destroy();
    gateway.close();
  });

  it("rejects an older transport after a newer one authenticates", async () => {
    const call = vi.fn(async () => ({
      text: "ok",
      structured: { ok: true },
    }));
    const { gateway, disconnect } = setup(
      { g1: { owner: "session-a", conversationId: null, active: true } },
      call,
    );
    const port = await gateway.listen("correct");
    const first = client(port);
    await first.opened;
    first.send({ token: "correct", grant: "g1" });
    first.send({ jsonrpc: "2.0", id: 30, method: "tools/list" });
    expect((await first.next()).result.tools).toBeTruthy();

    const second = client(port);
    await second.opened;
    second.send({ token: "correct", grant: "g1" });
    second.send({ jsonrpc: "2.0", id: 31, method: "tools/list" });
    expect((await second.next()).result.tools).toBeTruthy();

    // The superseded transport is closed, but its close must not end the grant.
    await first.closed;
    expect(disconnect).not.toHaveBeenCalled();

    second.socket.destroy();
    await second.closed;
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledWith("g1"),
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
    gateway.close();
  });
});

describe("BrowserGateway observation content", () => {
  it("returns a text-only observation with a structured outline by default", async () => {
    const call = vi.fn(async () => ({
      text: 'Observation obs-1\n[1] button "Submit"',
      structured: {
        observationId: "obs-1",
        outline: '[1] button "Submit"',
        elements: 1,
        screenshot: false,
      },
    }));
    const { gateway } = setup(
      { g1: { owner: "session-a", conversationId: null, active: true } },
      call,
    );
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct", grant: "g1" });
    connection.send({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "nuwax_browser_observe", arguments: {} },
    });
    const reply = await connection.next();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "nuwax_browser_observe",
        args: {},
      }),
    );
    expect(reply.result.content).toHaveLength(1);
    expect(reply.result.content[0]).toMatchObject({ type: "text" });
    expect(reply.result.content[0].text).toContain('[1] button "Submit"');
    expect(reply.result.structuredContent).toMatchObject({
      observationId: "obs-1",
      outline: '[1] button "Submit"',
      elements: 1,
      screenshot: false,
    });
    connection.socket.destroy();
    gateway.close();
  });

  it("adds an image only when the observation explicitly requests it", async () => {
    const call = vi.fn(async () => ({
      text: "Observation obs-2\n[1] button",
      structured: {
        observationId: "obs-2",
        outline: "[1] button",
        elements: 1,
        screenshot: true,
      },
      image: { mimeType: "image/jpeg", data: "aGVsbG8=" },
    }));
    const { gateway } = setup(
      { g1: { owner: "session-a", conversationId: null, active: true } },
      call,
    );
    const port = await gateway.listen("correct");
    const connection = client(port);
    await connection.opened;
    connection.send({ token: "correct", grant: "g1" });
    connection.send({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "nuwax_browser_observe",
        arguments: { screenshot: true },
      },
    });
    const reply = await connection.next();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "nuwax_browser_observe",
        args: { screenshot: true },
      }),
    );
    expect(reply.result.content).toHaveLength(2);
    expect(reply.result.content[0].text).toContain("[1] button");
    expect(reply.result.content[1]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/jpeg",
    });
    expect(reply.result.structuredContent.outline).toContain("[1] button");
    expect(reply.result.structuredContent.screenshot).toBe(true);
    connection.socket.destroy();
    gateway.close();
  });
});
