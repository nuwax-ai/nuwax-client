/**
 * 启动时向 Wayland 合成器查询它对外公布的接口（globals）。
 *
 * Chromium 在原生 Wayland 下只能通过合成器的 text-input 协议接入输入法，不同合成器支持的
 * 协议版本并不一样，所以需要在决定窗口后端之前知道当前合成器到底提供哪些接口。
 *
 * 这里直接按 Wayland 线协议发两个请求（get_registry、sync），读完一轮 registry 事件就断开，
 * 不依赖 libwayland，任何 Linux 发行版上都能用。
 */
import * as net from "node:net";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

/** 等合成器回应的上限；本机 Unix socket 上一轮往返通常在 1 毫秒以内。 */
export const WAYLAND_QUERY_TIMEOUT_MS = 1000;

/**
 * 连接合成器并读取它公布的全部接口名；连不上、超时或协议异常时返回 null。
 *
 * 这个函数不能引用模块里的任何变量：它的源码会被序列化后放进 worker 线程执行（见 hasWaylandGlobalSync）。
 */
export function queryWaylandGlobals(socketPath: string, timeoutMs: number, net: typeof import("node:net")): Promise<string[] | null> {
  return new Promise((resolve) => {
    const interfaces: string[] = [];
    let pending = Buffer.alloc(0);
    let settled = false;
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.createConnection(socketPath, () => {
      // 每条消息的头是两个 32 位字：发送方的对象 id，以及（消息长度 << 16 | 操作码），长度从头开始算。
      // wl_display 固定是 1 号对象：get_registry 的操作码是 1，sync 是 0；new_id 参数就是客户端自己分配的对象 id。
      const getRegistry = Buffer.alloc(12);
      getRegistry.writeUInt32LE(1, 0);
      getRegistry.writeUInt32LE((12 << 16) | 1, 4);
      getRegistry.writeUInt32LE(2, 8);
      const sync = Buffer.alloc(12);
      sync.writeUInt32LE(1, 0);
      sync.writeUInt32LE((12 << 16) | 0, 4);
      sync.writeUInt32LE(3, 8);
      socket.write(Buffer.concat([getRegistry, sync]));
    });
    AbortSignal.timeout(timeoutMs).addEventListener("abort", () => finish(null));
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 8) return;
        const objectId = pending.readUInt32LE(0);
        const opcode = pending.readUInt16LE(4);
        const size = pending.readUInt16LE(6);
        if (size < 8) return finish(null);
        if (pending.length < size) return;
        const body = pending.subarray(8, size);
        if (objectId === 1 && opcode === 0) return finish(null); // wl_display.error
        if (objectId === 2 && opcode === 0) {
          // wl_registry.global：name（uint）、interface（字符串）、version（uint）。
          // 字符串是含结尾 NUL 的长度 + 内容，再补齐到 4 字节。
          const length = body.length >= 8 ? body.readUInt32LE(4) : 0;
          if (length < 1 || 8 + length > body.length) return finish(null);
          interfaces.push(body.subarray(8, 8 + length - 1).toString("latin1"));
        }
        if (objectId === 3 && opcode === 0) return finish(interfaces); // wl_callback.done：这一轮 registry 事件已发完
        pending = pending.subarray(size);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

/** 异步版，供不需要阻塞的调用方和测试使用。 */
export function readWaylandGlobals(socketPath: string, timeoutMs = WAYLAND_QUERY_TIMEOUT_MS): Promise<string[] | null> {
  return queryWaylandGlobals(socketPath, timeoutMs, net);
}

/**
 * 同步版：主进程必须在 app ready 之前决定窗口后端，而 Node 没有同步的 socket 接口，
 * 所以把查询放进 worker 线程，主线程用 Atomics.wait 等它一小会儿。
 *
 * @returns true 合成器提供该接口；false 读到了注册表但没有该接口；null 没问到（没有 Wayland、超时、出错）
 */
export function hasWaylandGlobalSync(socketPath: string, name: string, timeoutMs = WAYLAND_QUERY_TIMEOUT_MS): boolean | null {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  try {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       (${queryWaylandGlobals.toString()})(workerData.socketPath, workerData.timeoutMs, require("node:net")).then(
         (list) => { Atomics.store(workerData.signal, 0, list ? (list.includes(workerData.name) ? 1 : 2) : 3); Atomics.notify(workerData.signal, 0); },
         () => { Atomics.store(workerData.signal, 0, 3); Atomics.notify(workerData.signal, 0); });`,
      { eval: true, workerData: { socketPath, timeoutMs, name, signal } },
    );
    try {
      Atomics.wait(signal, 0, 0, timeoutMs + 200);
    } finally {
      void worker.terminate();
    }
  } catch {
    return null;
  }
  return signal[0] === 1 ? true : signal[0] === 2 ? false : null;
}

/** 合成器的 socket 路径：`WAYLAND_DISPLAY` 可以是绝对路径，也可以是相对 `XDG_RUNTIME_DIR` 的名字。 */
export function waylandSocketPath(env: { WAYLAND_DISPLAY?: string; XDG_RUNTIME_DIR?: string } = process.env): string | null {
  const display = env.WAYLAND_DISPLAY;
  if (!display) return null;
  if (path.isAbsolute(display)) return display;
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, display) : null;
}
