import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { hasWaylandGlobalSync, readWaylandGlobals, waylandSocketPath } from "./waylandRegistry";

interface CompositorOptions {
  /** false：只收不应，模拟合成器没有回应。 */
  reply?: boolean;
  /** true：每条消息切成两段、逐条发送，模拟消息分片到达。 */
  fragment?: boolean;
  /** true：回一条长度比消息头还短的畸形消息。 */
  garbage?: boolean;
}
type CompositorMessage = { type: "listening" } | { type: "request"; bytes: number[] };

/**
 * 假合成器的主体。它跑在独立的线程里：同步查询会阻塞调用它的线程，合成器如果也在这个线程上，
 * 就永远等不到应答（真实合成器是另一个进程，没有这个问题）。
 * 所以这里不引用模块级的任何变量，net 和通信端口都由启动它的代码传进来。
 */
function runCompositor(options: CompositorOptions & { socketPath: string; globals: string[] }, net: typeof import("node:net"),
  port: { postMessage(message: unknown): void } | null) {
  const uint = (value: number) => {
    const word = Buffer.alloc(4);
    word.writeUInt32LE(value);
    return word;
  };
  /** Wayland 字符串：含结尾 NUL 的长度 + 内容，补齐到 4 字节。 */
  const waylandString = (value: string) => {
    const bytes = Buffer.from(value, "latin1");
    const padded = Math.ceil((bytes.length + 1) / 4) * 4;
    return Buffer.concat([uint(bytes.length + 1), bytes, Buffer.alloc(padded - bytes.length)]);
  };
  /** 一条 Wayland 事件：发送方的对象 id、（消息长度 << 16 | 操作码），然后是参数。 */
  const event = (objectId: number, opcode: number, ...args: Buffer[]) => {
    const body = Buffer.concat(args);
    const head = Buffer.alloc(8);
    head.writeUInt32LE(objectId, 0);
    head.writeUInt32LE((8 + body.length) << 16 | opcode, 4);
    return Buffer.concat([head, body]);
  };
  net.createServer((client) => {
    // 客户端读完就会断开，分片模式下剩下的几段再写会报 EPIPE；这是夹具自身的事，忽略即可。
    client.on("error", () => undefined);
    client.on("data", (chunk: Buffer) => {
      port?.postMessage({ type: "request", bytes: Array.from(chunk) });
      if (!options.reply) return;
      if (options.garbage) {
        const broken = Buffer.alloc(8);
        broken.writeUInt32LE(1, 0);
        broken.writeUInt32LE(4 << 16, 4);
        client.write(broken);
        return;
      }
      // 与真实合成器的顺序一致：先发全部 global，再回答 sync（wl_callback.done），最后 delete_id。
      const events = [
        ...options.globals.map((name, index) => event(2, 0, uint(index + 1), waylandString(name), uint(1))),
        event(3, 0, uint(0)),
        event(1, 1, uint(3)),
      ];
      if (!options.fragment) {
        client.write(Buffer.concat(events));
        return;
      }
      const pieces = events.flatMap((message) => {
        const cut = Math.max(1, Math.floor(message.length / 3));
        return [message.subarray(0, cut), message.subarray(cut)];
      });
      const next = () => {
        const piece = pieces.shift();
        if (!piece) return;
        client.write(piece);
        setTimeout(next, 1);
      };
      next();
    });
  }).listen(options.socketPath, () => port?.postMessage({ type: "listening" }));
}

interface FakeCompositor {
  socketPath: string;
  /** 收到的每一笔原始字节，用来核对客户端发了什么。 */
  requests: number[][];
}

const running: { worker: Worker; dir: string }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(async ({ worker, dir }) => {
    await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }));
});

function serve(globals: string[], options: CompositorOptions = { reply: true }): Promise<FakeCompositor> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-wayland-"));
  const socketPath = path.join(dir, "wayland-0");
  const requests: number[][] = [];
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");\n(${runCompositor.toString()})(workerData, require("node:net"), parentPort);`,
    { eval: true, workerData: { ...options, socketPath, globals } },
  );
  running.push({ worker, dir });
  return new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message: CompositorMessage) => {
      if (message.type === "request") requests.push(message.bytes);
      if (message.type === "listening") resolve({ socketPath, requests });
    });
  });
}

describe("Wayland registry query", () => {
  it("sends get_registry and sync, then reports every interface the compositor advertises", async () => {
    const compositor = await serve(["wl_compositor", "zwp_text_input_manager_v2", "xdg_wm_base"]);
    await expect(readWaylandGlobals(compositor.socketPath, 2000)).resolves.toEqual([
      "wl_compositor",
      "zwp_text_input_manager_v2",
      "xdg_wm_base",
    ]);
    // 两条 12 字节的请求，对象 id、（长度 << 16 | 操作码）、new_id 各一个字：
    // wl_display(1).get_registry → 2 号对象，wl_display(1).sync → 3 号对象。
    // 请求记录是从合成器所在线程经消息传回来的，与查询结果走的不是一条通道，
    // 负载高时会晚于结果到达：等到它到了再比对。
    await vi.waitFor(() => {
      expect(compositor.requests.flat()).toEqual([
        1, 0, 0, 0, 1, 0, 12, 0, 2, 0, 0, 0,
        1, 0, 0, 0, 0, 0, 12, 0, 3, 0, 0, 0,
      ]);
    });
  });

  it("reassembles messages that arrive in pieces", async () => {
    const compositor = await serve(["wl_shm", "zwp_text_input_manager_v3"], { reply: true, fragment: true });
    await expect(readWaylandGlobals(compositor.socketPath, 2000)).resolves.toEqual(["wl_shm", "zwp_text_input_manager_v3"]);
  });

  it("returns null when there is no compositor to talk to", async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-wayland-")), "wayland-0");
    try {
      await expect(readWaylandGlobals(missing, 2000)).resolves.toBeNull();
    } finally {
      fs.rmSync(path.dirname(missing), { recursive: true, force: true });
    }
  });

  it("gives up after the timeout when the compositor never answers", async () => {
    const compositor = await serve([], { reply: false });
    const started = Date.now();
    await expect(readWaylandGlobals(compositor.socketPath, 150)).resolves.toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports a malformed message as unknown instead of throwing", async () => {
    const compositor = await serve([], { reply: true, garbage: true });
    await expect(readWaylandGlobals(compositor.socketPath, 2000)).resolves.toBeNull();
  });

  it("locates the compositor socket from the session environment", () => {
    expect(waylandSocketPath({ WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/wayland-0");
    expect(waylandSocketPath({ WAYLAND_DISPLAY: "/tmp/elsewhere/wayland-1", XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/tmp/elsewhere/wayland-1");
    expect(waylandSocketPath({ WAYLAND_DISPLAY: "wayland-0" })).toBeNull();
    expect(waylandSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBeNull();
  });
});

describe("synchronous Wayland query", () => {
  it("answers true when the compositor offers the interface, without blocking for long", async () => {
    const compositor = await serve(["wl_compositor", "zwp_text_input_manager_v3"]);
    const started = Date.now();
    expect(hasWaylandGlobalSync(compositor.socketPath, "zwp_text_input_manager_v3")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("answers false when the registry was read and the interface is missing", async () => {
    const compositor = await serve(["wl_compositor", "zwp_text_input_manager_v2"]);
    expect(hasWaylandGlobalSync(compositor.socketPath, "zwp_text_input_manager_v3")).toBe(false);
  });

  it("answers null when the compositor cannot be reached or does not answer", async () => {
    const silent = await serve([], { reply: false });
    const started = Date.now();
    expect(hasWaylandGlobalSync(silent.socketPath, "zwp_text_input_manager_v3", 150)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(hasWaylandGlobalSync(silent.socketPath + ".missing", "zwp_text_input_manager_v3", 150)).toBeNull();
  });
});
