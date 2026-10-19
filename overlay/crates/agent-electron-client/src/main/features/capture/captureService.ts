/**
 * 截屏 / 录屏服务：单会话状态机 + 参数校验 + 编码 + 结果仓。
 *
 * 依赖全部注入（采集引擎、编码器、权限、显示器、结果仓），本文件不 import electron，
 * 因而可以完整单测。真实引擎（desktopCapturer、覆盖层窗口、录制器）在各自模块里实现。
 *
 * 语义要点：
 * - 同一时刻只有一个会话（`busy`）；
 * - 用户取消是正常结果（`canceled`），不是错误；
 * - 登出/换域/退出走 `endSession()`：取消进行中的会话并清空全部结果；
 * - 录制引擎未注入时 `record()` 返回 `unsupported`（Phase 3 提供）。
 */

import {
  CAPTURE_API_VERSION,
  type CaptureCapabilities,
  type CapturePermission,
  type CaptureQuality,
  type CaptureResult,
  type CaptureState,
  type CaptureErrorCode,
  type RecordOptions,
} from "@shared/features/capture/contract";
import { summarizeDisplays, type DisplayLike } from "./hdr";
import { DEFAULT_RECORDING_DURATION_MS } from "@shared/features/capture/recordingPreferences";
import { parseRecordOptions, parseScreenshotOptions } from "./options";
import type { ResultStore } from "./results";
import { encodeStill, type NativeImageLike, type StillEncoder } from "./stillEncoder";
import { describeTiers } from "./tiers";
import type { CaptureWindowVisibility } from "./windowVisibility";

export interface StillCapture {
  image: NativeImageLike;
  /** 采集自 HDR 屏并已转为 SDR/sRGB。 */
  hdrToneMapped: boolean;
}

export interface StillEngine {
  /** 采集一张静态图；用户取消返回 null；`signal` 被中止时应尽快返回。 */
  captureStill(signal: AbortSignal): Promise<StillCapture | null>;
}

export interface RecordCapture {
  data?: Buffer;
  /** 主进程内部的完成产物；结果仓接管后调用 disposeFile，无路径跨 preload。 */
  filePath?: string;
  disposeFile?(): void;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  qualityUsed: CaptureQuality;
  hdrToneMapped: boolean;
  exceedsMaxBytes?: boolean;
  paddedForEvenSize?: boolean;
}

export interface RecordEngine {
  formats(): { video: Array<"mp4" | "webm">; gif: boolean };
  /** 完成（用户停止/达上限）后返回结果；用户取消返回 null。 */
  record(
    options: RecordOptions,
    signal: AbortSignal,
    onState: (state: CaptureState) => void,
  ): Promise<RecordCapture | null>;
}

export interface CaptureServiceDeps {
  platform: NodeJS.Platform;
  backendAvailable?(): boolean;
  getPermission(): CapturePermission;
  /** Guides the user to grant access; fire-and-forget so the caller still gets its result immediately. */
  onPermissionDenied?(): void;
  windowVisibility?: CaptureWindowVisibility;
  getRecordingDurationLimit?(): number;
  getDisplays(): DisplayLike[];
  stillEngine: StillEngine;
  stillEncoder: StillEncoder;
  recordEngine?: RecordEngine;
  results: ResultStore;
  log: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export interface CaptureService {
  getCapabilities(): CaptureCapabilities;
  getState(): CaptureState;
  screenshot(rawOptions: unknown): Promise<CaptureResult>;
  record(rawOptions: unknown): Promise<CaptureResult>;
  cancel(): void;
  readChunk(resultId: string, offset: number, length: number): Buffer | null;
  release(resultId: string): void;
  onStateChange(listener: (state: CaptureState) => void): () => void;
  /** 登出/换域/退出：取消进行中的会话并清空全部结果。 */
  endSession(): void;
}

const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "win32", "linux"];

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  let state: CaptureState = "idle";
  let controller: AbortController | null = null;
  const listeners = new Set<(state: CaptureState) => void>();

  const setState = (next: CaptureState) => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        deps.log.warn("[Capture] state listener failed", error);
      }
    }
  };

  const platformSupported = () => SUPPORTED_PLATFORMS.includes(deps.platform) && (deps.backendAvailable?.() ?? true);

  const preflight = (): CaptureResult | null => {
    if (!platformSupported()) {
      return { success: false, code: "unsupported", error: `desktop capture is not available on ${deps.platform}` };
    }
    if (state !== "idle") {
      return { success: false, code: "busy", error: "another capture session is in progress" };
    }
    const permission = deps.getPermission();
    if (permission === "denied" || permission === "not-determined") {
      deps.onPermissionDenied?.();
      return { success: false, code: "permission-denied", error: "screen recording permission denied" };
    }
    return null;
  };

  const failure = (error: unknown): CaptureResult => ({
    success: false,
    code: error instanceof Error &&
      ["canceled", "permission-denied", "encoder-unavailable", "unsupported"].includes(String((error as Error & { code?: string }).code))
      ? (error as Error & { code: CaptureErrorCode }).code : "failed",
    error: error instanceof Error ? error.message : String(error),
  });

  return {
    getState: () => state,

    getCapabilities() {
      const record = deps.recordEngine?.formats() ?? { video: [], gif: false };
      return {
        apiVersion: CAPTURE_API_VERSION,
        available: platformSupported(),
        platform: deps.platform,
        permission: deps.getPermission(),
        displays: summarizeDisplays(deps.getDisplays()),
        formats: {
          still: deps.stillEncoder.supportedFormats(),
          video: record.video,
          gif: record.gif,
        },
        tiers: describeTiers(),
      };
    },

    async screenshot(rawOptions) {
      const parsed = parseScreenshotOptions(rawOptions);
      if (!parsed.ok) return { success: false, code: "invalid-argument", error: parsed.error };
      const options = parsed.value;
      if (options.format && !deps.stillEncoder.supportedFormats().includes(options.format)) {
        return { success: false, code: "unsupported", error: `format ${options.format} is not supported` };
      }
      const blocked = preflight();
      if (blocked) return blocked;

      const abort = new AbortController();
      controller = abort;
      setState("selecting");
      try {
        if (deps.windowVisibility) await deps.windowVisibility.hide(abort.signal);
        if (abort.signal.aborted) return { success: false, code: "canceled" };
        const capture = await deps.stillEngine.captureStill(abort.signal);
        if (abort.signal.aborted || capture === null) {
          return { success: false, code: "canceled" };
        }
        setState("encoding");
        const encoded = await encodeStill(capture.image, options, deps.stillEncoder);
        if (abort.signal.aborted) return { success: false, code: "canceled" };
        const stored = deps.results.put(encoded.data, encoded.mime);
        return {
          success: true,
          resultId: stored.resultId,
          mime: encoded.mime,
          bytes: stored.bytes,
          width: encoded.width,
          height: encoded.height,
          qualityUsed: encoded.qualityUsed,
          ...(encoded.exceedsMaxBytes ? { exceedsMaxBytes: true } : {}),
          hdrToneMapped: capture.hdrToneMapped,
        };
      } catch (error) {
        if (abort.signal.aborted) return { success: false, code: "canceled" };
        deps.log.error("[Capture] screenshot failed", error);
        return failure(error);
      } finally {
        deps.windowVisibility?.restore();
        controller = null;
        setState("idle");
      }
    },

    async record(rawOptions) {
      const parsed = parseRecordOptions(rawOptions);
      if (!parsed.ok) return { success: false, code: "invalid-argument", error: parsed.error };
      const options = parsed.value;
      const durationLimit = deps.getRecordingDurationLimit?.() ?? DEFAULT_RECORDING_DURATION_MS;
      options.maxDurationMs = Math.min(options.maxDurationMs ?? durationLimit, durationLimit);
      if (!platformSupported()) return { success: false, code: 'unsupported', error: `desktop capture is not available on ${deps.platform}` };
      const engine = deps.recordEngine;
      if (!engine) {
        return { success: false, code: "unsupported", error: "recording is not available" };
      }
      const formats = engine.formats();
      const outputSupported =
        options.output === "gif" ? formats.gif : formats.video.includes(options.output);
      if (!outputSupported) {
        return { success: false, code: "encoder-unavailable", error: `${options.output} encoder is not available` };
      }
      const blocked = preflight();
      if (blocked) return blocked;

      const abort = new AbortController();
      controller = abort;
      setState("selecting");
      try {
        if (deps.windowVisibility) await deps.windowVisibility.hide(abort.signal);
        if (abort.signal.aborted) return { success: false, code: "canceled" };
        const capture = await engine.record(options, abort.signal, setState);
        try {
          if (abort.signal.aborted || capture === null) {
            return { success: false, code: "canceled" };
          }
          const stored = capture.filePath
            ? deps.results.putFile(capture.filePath, capture.mime)
            : capture.data ? deps.results.put(capture.data, capture.mime) : null;
          if (!stored) throw new Error("recording engine returned no output");
          return {
          success: true,
          resultId: stored.resultId,
          mime: capture.mime,
          bytes: stored.bytes,
          width: capture.width,
          height: capture.height,
          durationMs: capture.durationMs,
          qualityUsed: capture.qualityUsed,
          ...(capture.exceedsMaxBytes ? { exceedsMaxBytes: true } : {}),
          hdrToneMapped: capture.hdrToneMapped,
          ...(capture.paddedForEvenSize ? { paddedForEvenSize: true } : {}),
          };
        } finally {
          capture?.disposeFile?.();
        }
      } catch (error) {
        if (abort.signal.aborted) return { success: false, code: "canceled" };
        deps.log.error("[Capture] record failed", error);
        return failure(error);
      } finally {
        deps.windowVisibility?.restore();
        controller = null;
        setState("idle");
      }
    },

    cancel() {
      controller?.abort();
    },

    readChunk: (resultId, offset, length) => deps.results.readChunk(resultId, offset, length),
    release: (resultId) => deps.results.release(resultId),

    onStateChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    endSession() {
      controller?.abort();
      deps.results.releaseAll();
    },
  };
}
