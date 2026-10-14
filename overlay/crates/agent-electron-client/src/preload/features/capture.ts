/**
 * preload 侧的 `capture` 命名空间工厂。
 *
 * 语义：
 * - 特性关闭（主进程没注册 IPC）：`getCapabilities()` 返回 `available:false`，其余调用返回
 *   `unsupported`——调用方只需判断一个字段，不会因为「No handler registered」崩溃；
 * - 处理函数真的抛错：返回 `failed` 并带上错误信息，**不静默吞掉**；
 * - `readChunk` 返回独立的 ArrayBuffer。
 */

import type { IpcRenderer } from "electron";
import {
  CAPTURE_IPC,
  type CaptureChannels,
  type CaptureBridge,
  type CaptureCapabilities,
  type CaptureResult,
  type CaptureCopyResult,
  type CaptureFailure,
  type CaptureState,
} from "@shared/features/capture/contract";
import { unavailableCapabilities } from "@shared/features/capture/unavailable";

type IpcLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

const NO_HANDLER = /No handler registered/i;

function toFailure(error: unknown): CaptureFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (NO_HANDLER.test(message)) {
    return { success: false, code: "unsupported", error: "capture feature is not available" };
  }
  return { success: false, code: "failed", error: message };
}

export function createCaptureBridge(ipc: IpcLike, channels: CaptureChannels = CAPTURE_IPC): CaptureBridge {
  return {
    async getCapabilities() {
      try {
        return (await ipc.invoke(channels.GET_CAPABILITIES)) as CaptureCapabilities;
      } catch {
        return unavailableCapabilities(process.platform);
      }
    },

    async screenshot(options) {
      try {
        return (await ipc.invoke(channels.SCREENSHOT, options)) as CaptureResult;
      } catch (error) {
        return toFailure(error);
      }
    },

    async record(options) {
      try {
        return (await ipc.invoke(channels.RECORD, options)) as CaptureResult;
      } catch (error) {
        return toFailure(error);
      }
    },

    async cancel() {
      try {
        await ipc.invoke(channels.CANCEL);
      } catch {
        // 特性关闭或没有进行中的会话：无事可做
      }
    },

    onStateChange(listener) {
      const handler = (_event: unknown, state: CaptureState) => listener(state);
      ipc.on(channels.STATE_CHANGED, handler);
      return () => {
        ipc.removeListener(channels.STATE_CHANGED, handler);
      };
    },

    async readChunk(resultId, offset, length) {
      try {
        const chunk = (await ipc.invoke(
          channels.READ_CHUNK,
          resultId,
          offset,
          length,
        )) as Uint8Array | null;
        if (!chunk) return null;
        return chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
          ? (chunk.buffer as ArrayBuffer)
          : (chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
      } catch {
        return null;
      }
    },

    async release(resultId) {
      try {
        await ipc.invoke(channels.RELEASE, resultId);
      } catch {
        // 同上
      }
    },

    async copy(resultId) {
      try {
        return await ipc.invoke(channels.COPY, resultId) as CaptureCopyResult;
      } catch (error) {
        return toFailure(error);
      }
    },
  };
}
