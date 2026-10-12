/** IM 接入示例：无 Electron、qiankun 或宿主 SDK 依赖。完整协议见 native-capture-api.md。 */
export type CaptureQuality = 'lossless' | 'high' | 'medium' | 'low';
export type CaptureState = 'idle' | 'selecting' | 'recording' | 'paused' | 'encoding';
export type CaptureErrorCode = 'canceled' | 'permission-denied' | 'busy' | 'encoder-unavailable'
  | 'unsupported' | 'untrusted' | 'invalid-argument' | 'failed';
export interface CaptureCompression { quality: CaptureQuality; maxBytes?: number }
export interface ScreenshotOptions { format?: 'png' | 'jpeg' | 'webp'; compression?: CaptureCompression }
export interface RecordOptions {
  output: 'mp4' | 'webm' | 'gif'; fps?: number; compression?: CaptureCompression; maxDurationMs?: number;
}
export interface CaptureCapabilities {
  apiVersion: number; available: boolean;
  permission: 'granted' | 'denied' | 'not-determined' | 'n/a';
  formats: { still: Array<'png' | 'jpeg' | 'webp'>; video: Array<'mp4' | 'webm'>; gif: boolean };
  displays: Array<{ id: string; hdr: boolean; scale: number }>;
}
export interface CaptureSuccess {
  success: true; resultId: string; mime: string; bytes: number;
  width: number; height: number; durationMs?: number; qualityUsed: CaptureQuality;
  exceedsMaxBytes?: boolean; hdrToneMapped: boolean; paddedForEvenSize?: boolean;
}
export type CaptureResult = CaptureSuccess | { success: false; code: CaptureErrorCode; error?: string };
export interface CaptureBridge {
  getCapabilities(): Promise<CaptureCapabilities>;
  screenshot(options?: ScreenshotOptions): Promise<CaptureResult>;
  record(options: RecordOptions): Promise<CaptureResult>;
  cancel(): Promise<void>;
  onStateChange(listener: (state: CaptureState) => void): () => void;
  readChunk(resultId: string, offset: number, length: number): Promise<ArrayBuffer | null>;
  release(resultId: string): Promise<void>;
}

/** 点击时调用，避免在模块加载时缓存宿主后注入的桥。 */
export function getNativeCapture(): CaptureBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as Window & { NuwaClawBridge?: { capture?: CaptureBridge } })
    .NuwaClawBridge?.capture;
  const methods = ['getCapabilities', 'screenshot', 'record', 'cancel', 'onStateChange', 'readChunk', 'release'] as const;
  return bridge && methods.every((name) => typeof bridge[name] === 'function') ? bridge : undefined;
}

export class CaptureFileError extends Error {
  readonly code: 'too-large' | 'expired' | 'invalid-result';
  constructor(code: CaptureFileError['code'], message: string) {
    super(message); this.name = 'CaptureFileError'; this.code = code;
  }
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'image/gif': 'gif',
};

/** maxUploadBytes 必须来自 IM 现有上传限制。返回 File 后走 addPending，不自动发消息。 */
export async function readCaptureFile(
  capture: Pick<CaptureBridge, 'readChunk' | 'release'>,
  result: CaptureSuccess,
  maxUploadBytes: number,
): Promise<File> {
  try {
    if (!Number.isSafeInteger(result.bytes) || result.bytes < 1 ||
      !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1 ||
      !Object.prototype.hasOwnProperty.call(EXTENSIONS, result.mime)) {
      throw new CaptureFileError('invalid-result', '截图或录屏结果不完整，请重试');
    }
    if (result.bytes > maxUploadBytes || result.exceedsMaxBytes) {
      throw new CaptureFileError('too-large', '截图或录屏超过发送限制，请降低画质或缩短录制');
    }
    const parts: ArrayBuffer[] = [];
    for (let offset = 0; offset < result.bytes;) {
      const length = Math.min(CHUNK_BYTES, result.bytes - offset);
      const part = await capture.readChunk(result.resultId, offset, length);
      if (!part || part.byteLength !== length) {
        throw new CaptureFileError('expired', '截图或录屏结果已失效，请重试');
      }
      parts.push(part); offset += part.byteLength;
    }
    const prefix = result.mime.startsWith('video/') || result.mime === 'image/gif' ? '录屏' : '截图';
    return new File(parts, `${prefix}-${Date.now()}.${EXTENSIONS[result.mime]}`, { type: result.mime });
  } finally {
    // 页面/会话已经结束时 release 也可能拒绝；不要覆盖原来的读取结果或诊断。
    await capture.release(result.resultId).catch(() => undefined);
  }
}

export type CaptureAttachmentRequest =
  | { kind: 'screenshot'; options?: ScreenshotOptions }
  | { kind: 'record'; options: RecordOptions };
export type CaptureAttachmentOutcome =
  | { status: 'attached' | 'canceled' | 'unavailable' | 'invalid-target' }
  | { status: 'failed'; code: CaptureErrorCode | CaptureFileError['code'] };

export interface CaptureComposerAdapter<Target> {
  /** 返回不可变的会话/草稿代次快照；不要把会随路由变化的 ref 本身作为 Target。 */
  getTarget(): Target | null;
  /** 检查原会话草稿是否仍存在、代次有效、仍可添加附件；不必等于当前可见会话。 */
  isTargetValid(target: Target): boolean;
  getMaxUploadBytes(target: Target, request: CaptureAttachmentRequest): number;
  /** 同步写入指定会话的待发送附件区，不上传、不发送、不依赖当前选中的会话。 */
  addPending(target: Target, files: File[]): void;
  getCapture?(): CaptureBridge | undefined;
  onBusyChange?(busy: boolean): void;
  onStateChange?(state: CaptureState): void;
}

/** 在 IM 应用层保留一份控制器，菜单调用 run；IM 卸载时 dispose。
 * 业务桥的 Promise 本身即本次调用的结果回调，不需要全局监听“录制完成”。 */
export function createCaptureAttachmentController<Target>(adapter: CaptureComposerAdapter<Target>) {
  let busy = false;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const detach = () => { const off = unsubscribe; unsubscribe = undefined; off?.(); };
  return {
    async run(request: CaptureAttachmentRequest): Promise<CaptureAttachmentOutcome> {
      if (disposed) return { status: 'invalid-target' };
      if (busy) return { status: 'failed', code: 'busy' };
      busy = true;
      let capture: CaptureBridge | undefined;
      let resultToRelease: CaptureSuccess | undefined;
      try {
        adapter.onBusyChange?.(true);
        // 在第一个 await 前固定目标，后续不能改为 currentConversationId。
        const target = adapter.getTarget();
        const valid = () => !disposed && target !== null && adapter.isTargetValid(target);
        if (target === null || !valid()) return { status: 'invalid-target' };
        const maxBytes = adapter.getMaxUploadBytes(target, request);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return { status: 'failed', code: 'invalid-argument' };
        capture = (adapter.getCapture ?? getNativeCapture)();
        if (!capture) return { status: 'unavailable' };
        const caps = await capture.getCapabilities();
        if (!valid()) return { status: 'invalid-target' };
        if (!caps.available) return { status: 'unavailable' };
        if (request.kind === 'record' && (request.options.output === 'gif'
          ? !caps.formats.gif : !caps.formats.video.includes(request.options.output))) {
          return { status: 'unavailable' };
        }
        if (request.kind === 'screenshot' && request.options?.format && !caps.formats.still.includes(request.options.format)) {
          return { status: 'unavailable' };
        }
        unsubscribe = capture.onStateChange(state => { if (valid()) adapter.onStateChange?.(state); });
        const result = request.kind === 'record'
          ? await capture.record(request.options) : await capture.screenshot(request.options);
        if (!result.success) return result.code === 'canceled'
          ? { status: 'canceled' } : { status: 'failed', code: result.code };
        resultToRelease = result;
        if (!valid()) return { status: 'invalid-target' };
        // readCaptureFile 接管句柄，成功与失败均会释放。
        resultToRelease = undefined;
        const file = await readCaptureFile(capture, result, maxBytes);
        if (!valid()) return { status: 'invalid-target' };
        adapter.addPending(target, [file]);
        return { status: 'attached' };
      } catch (error) {
        return { status: 'failed', code: error instanceof CaptureFileError ? error.code : 'failed' };
      } finally {
        if (capture && resultToRelease) await capture.release(resultToRelease.resultId).catch(() => undefined);
        try { detach(); } finally { busy = false; if (!disposed) adapter.onBusyChange?.(false); }
      }
    },
    dispose() {
      disposed = true;
      detach();
      // 不调用共享 WebContents 的 cancel：不能误取消同页其他入口。迟到结果仍释放。
    },
  };
}
