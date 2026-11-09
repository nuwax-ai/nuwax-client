import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScratchDir } from "../_kit/scratchDir";
import { createFeatureLifecycle } from "../_kit/lifecycle";
import type { FeatureContext, FeatureMcpServerEntry } from "../_kit/types";
import type {
  AgentSessionParticipant,
  AgentMcpServer,
} from "../_kit/agentSessions";
import { ANDROID_IPC } from "@shared/features/android/contract";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
const power = new EventEmitter();
vi.mock("electron", () => ({
  powerMonitor: {
    on: (...args: any[]) => power.on(args[0], args[1]),
    removeListener: (...args: any[]) => power.removeListener(args[0], args[1]),
  },
}));
vi.mock("./adb", async (original) => ({
  ...(await original<object>()),
  runAdb: mocks.run,
}));
import { androidFeature } from "./index";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.clearAllMocks();
});
function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nuwax-android-test-"),
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  let factory!: () => AgentSessionParticipant,
    entry: FeatureMcpServerEntry | null = null,
    authenticated = true;
  const lifecycle = createFeatureLifecycle();
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(200, 20);
  mocks.run.mockImplementation(async (_file: string, args: string[]) =>
    args[0] === "version"
      ? Buffer.from("Android Debug Bridge version 1.0.41")
      : args[0] === "devices"
        ? Buffer.from("a device model:Pixel\n")
        : args.includes("get-state")
          ? Buffer.from("device")
          : png,
  );
  const ctx = {
    session: { isAuthenticated: () => authenticated },
    scratch: createScratchDir(directory),
    activities: { set: vi.fn() },
    lifecycle,
    hostIpc: {
      handle: (channel: string, handler: (...args: any[]) => any) =>
        handlers.set(channel, handler),
      dispose: vi.fn(),
    },
    agent: {
      resolveNodeBinary: () => process.execPath,
      setLocalMcpServer: vi.fn(
        async (_id: string, value: FeatureMcpServerEntry | null) => {
          entry = value;
        },
      ),
      registerSessionParticipant: (value: () => AgentSessionParticipant) => {
        factory = value;
        return () => undefined;
      },
    },
  } as unknown as FeatureContext;
  const feature = androidFeature.register(ctx);
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => feature.dispose());
  const call = (channel: string, input?: unknown) =>
    handlers.get(channel)!({}, input);
  return {
    call,
    lifecycle,
    ctx,
    auth: (value: boolean) => (authenticated = value),
    entry: () => entry,
    participant: () => factory(),
    enable: () => call(ANDROID_IPC.enable, { adbPath: "adb", serial: "a" }),
  };
}
async function connect(server: AgentMcpServer) {
  const env = Object.fromEntries(
    server.env!.map(({ name, value }) => [name, value]),
  );
  const child = spawn(server.command!, server.args!, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const waiters = new Map<number, (value: any) => void>();
  let buffer = "",
    id = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const result = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiters.get(result.id)?.(result);
      waiters.delete(result.id);
    }
  });
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await exited;
  });
  return {
    request(method: string, params?: unknown): Promise<any> {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(
          () => reject(new Error("MCP timed out")),
          2000,
        );
        waiters.set(key, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n",
        );
      });
    },
  };
}
describe("Android 特性、MCP 及 Agent 生命周期", () => {
  it("默认关闭，不读取手机；未登录不能开启", async () => {
    const f = fixture();
    await Promise.resolve();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(f.call(ANDROID_IPC.status)).toMatchObject({ enabled: false });
    f.auth(false);
    expect(await f.enable()).toMatchObject({
      enabled: false,
      error: "loginRequired",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("只管理自己的 MCP 条目，保留用户已有 Android 配置", async () => {
    const f = fixture();
    await f.enable();
    const servers: AgentMcpServer[] = [
      { name: "android", command: "user-owned-server" },
    ];
    f.participant().prepare(servers);
    expect(servers[0]).toEqual({
      name: "android",
      command: "user-owned-server",
    });
    expect(servers[1].name).toBe("nuwax-android");
    expect(
      vi
        .mocked(f.ctx.agent.setLocalMcpServer)
        .mock.calls.every(([id]) => id === "nuwax-android"),
    ).toBe(true);
  });
  it("允许 MCP 在会话绑定前初始化，只有活动轮次能执行手机工具", async () => {
    const f = fixture();
    expect(await f.enable()).toMatchObject({ enabled: true });
    const participant = f.participant(),
      servers: AgentMcpServer[] = [];
    const preparation = participant.prepare(servers);
    const client = await connect(servers[0]);
    expect(
      (await client.request("initialize", { protocolVersion: "2025-06-18" }))
        .result.capabilities,
    ).toEqual({ tools: {} });
    expect((await client.request("tools/list")).result.tools).toHaveLength(5);
    expect(
      (await client.request("tools/call", { name: "android_screenshot" })).error
        .message,
    ).toBe("notAuthorized");
    preparation.bind("session");
    const first = participant.start("session");
    expect(
      (await client.request("tools/call", { name: "android_screenshot" }))
        .result.content[1].type,
    ).toBe("image");
    participant.finish("session", first, false);
    expect(
      (await client.request("tools/call", { name: "android_screenshot" }))
        .result.isError,
    ).toBe(true);
    const second = participant.start("session");
    participant.finish("session", first, false);
    expect(second).not.toBe(first);
    expect(
      (await client.request("tools/call", { name: "android_screenshot" }))
        .result.isError,
    ).toBeUndefined();
    await f.call(ANDROID_IPC.stop);
    expect(f.entry()).toBeNull();
    expect(
      (await client.request("tools/call", { name: "android_screenshot" })).error
        .message,
    ).toBe("notAuthorized");
  });
  it("不同引擎相同 sessionId 不能共享截图或取消彼此", async () => {
    const f = fixture();
    await f.enable();
    const a = f.participant(),
      b = f.participant(),
      sa: AgentMcpServer[] = [],
      sb: AgentMcpServer[] = [];
    a.prepare(sa).bind("same");
    b.prepare(sb).bind("same");
    const ca = await connect(sa[0]),
      cb = await connect(sb[0]);
    a.start("same");
    b.start("same");
    const shot = JSON.parse(
      (await ca.request("tools/call", { name: "android_screenshot" })).result
        .content[0].text,
    );
    expect(
      (
        await cb.request("tools/call", {
          name: "android_tap",
          arguments: { observationId: shot.observationId, x: 0, y: 0 },
        })
      ).result.content[0].text,
    ).toBe("observeAgain");
    a.cancel("same");
    expect(
      (await cb.request("tools/call", { name: "android_screenshot" })).result
        .isError,
    ).toBeUndefined();
  });
  it.each(["lock", "logout", "services"])(
    "%s 同步撤销并移除 MCP，不自动恢复",
    async (reason) => {
      const f = fixture();
      await f.enable();
      if (reason === "lock") power.emit("lock-screen");
      else if (reason === "logout") f.lifecycle.emitSessionInvalidated();
      else await f.lifecycle.emitServicesStopping();
      expect(f.call(ANDROID_IPC.status).enabled).toBe(false);
      await vi.waitFor(() => expect(f.entry()).toBeNull());
      expect(f.participant().start("old-session")).toBe(0);
    },
  );
});
