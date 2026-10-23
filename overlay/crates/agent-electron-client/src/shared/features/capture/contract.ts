/**
 * 截屏 / 录屏特性的对外契约（IPC 通道名 + 公开类型）。
 *
 * main / preload / renderer 三端共用，不依赖 Electron 与任何业务模块。
 *
 * 公开类型的长期事实源在前端仓 `src/types/interfaces/hostBridge.ts`（`capture` 命名空间）；
 * 前端契约落地前，以本文件为草案，落地时两处必须逐字一致。契约只增不改。
 */

/** 契约版本，只增不改；调用方用它做能力探测。 */
export const CAPTURE_API_VERSION = 1;

export const CAPTURE_IPC = {
  GET_CAPABILITIES: "capture:getCapabilities",
  SCREENSHOT: "capture:screenshot",
  RECORD: "capture:record",
  CANCEL: "capture:cancel",
  READ_CHUNK: "capture:readChunk",
  RELEASE: "capture:release",
  COPY: "capture:copy",
  STATE_CHANGED: "capture:stateChanged",
} as const;

/** 宿主壳入口使用独立通道，不能扩大业务页 IPC 的受信边界。 */
export type CaptureChannels = { [K in keyof typeof CAPTURE_IPC]: string };
export const HOST_CAPTURE_IPC: CaptureChannels = {
  GET_CAPABILITIES: "capture:host:getCapabilities",
  SCREENSHOT: "capture:host:screenshot",
  RECORD: "capture:host:record",
  CANCEL: "capture:host:cancel",
  READ_CHUNK: "capture:host:readChunk",
  RELEASE: "capture:host:release",
  COPY: "capture:host:copy",
  STATE_CHANGED: "capture:host:stateChanged",
};
export const HOST_CAPTURE_SAVE_IPC = "capture:host:save";
/** 原生菜单仅向宿主壳发送命令，不进入业务页公开桥。 */
export const HOST_CAPTURE_MENU_IPC = "capture:host:menu";
export const CAPTURE_INTERACTIVE_IPC = 'capture:interactive';
export const CAPTURE_SHORTCUT_REQUEST_IPC = 'capture:shortcut:request';
export const CAPTURE_SHORTCUT_ACK_IPC = 'capture:shortcut:ack';
export type CaptureMenuAction = "screenshot" | RecordOutput;

export interface HostCaptureBridge extends CaptureBridge {
  /** Host-only fast probe: still capture does not depend on video resource verification. */
  getCapabilities(options?: { includeRecording?: boolean }): Promise<CaptureCapabilities>;
  save(resultId: string): Promise<{ success: boolean; canceled?: boolean; error?: string }>;
  onMenuAction?(listener: (action: CaptureMenuAction) => void): () => void;
}

/** 压缩档。像素尺寸在任何一档都不变，只改变编码质量。 */
export type CaptureQuality = "lossless" | "high" | "medium" | "low";

export const CAPTURE_QUALITIES: readonly CaptureQuality[] = [
  "lossless",
  "high",
  "medium",
  "low",
];

export type StillFormat = "png" | "jpeg" | "webp";
export type VideoFormat = "mp4" | "webm";
export type RecordOutput = VideoFormat | "gif";

export interface CaptureCompression {
  quality: CaptureQuality;
  /** 给定则从所选档逐级下探直到达标；任何情况下都不缩放像素。 */
  maxBytes?: number;
}

export type CapturePermission = "granted" | "denied" | "not-determined" | "n/a";

export interface CaptureDisplayInfo {
  id: string;
  hdr: boolean;
  scale: number;
}

/** 某一档的实际含义，供调用方据此决定压缩策略。数值为只读说明。 */
export interface TierDescriptor {
  quality: CaptureQuality;
  /** 静态图是否严格无损（仅 lossless 档的 PNG）。视频与 GIF 恒为有损。 */
  stillStrictlyLossless: boolean;
  /** JPEG / WebP 质量（1-100）；lossless 档为 null。 */
  stillQuality: number | null;
  /** 视频每像素每帧比特数。 */
  videoBitsPerPixel: number;
  /** GIF 帧率上限。 */
  gifMaxFps: number;
  /** GIF 调色板色数。 */
  gifColors: number;
}

export interface CaptureCapabilities {
  apiVersion: number;
  /** false 表示本机当前不能用（特性关闭/平台不支持），其余字段仍尽量给出。 */
  available: boolean;
  platform: NodeJS.Platform;
  permission: CapturePermission;
  displays: CaptureDisplayInfo[];
  formats: { still: StillFormat[]; video: VideoFormat[]; gif: boolean };
  tiers: Record<CaptureQuality, TierDescriptor>;
}

export interface ScreenshotOptions {
  format?: StillFormat;
  compression?: CaptureCompression;
}

export interface RecordOptions {
  output: RecordOutput;
  fps?: number;
  compression?: CaptureCompression;
  /** 录制时长上限（毫秒），缺省使用特性默认值。 */
  maxDurationMs?: number;
}

export type CaptureErrorCode =
  | "canceled"
  | "permission-denied"
  | "busy"
  | "encoder-unavailable"
  | "unsupported"
  | "untrusted"
  | "invalid-argument"
  | "failed";

export interface CaptureSuccess {
  success: true;
  /** 不透明句柄；渲染进程拿不到文件路径。 */
  resultId: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  durationMs?: number;
  /** 实际使用的档位；`maxBytes` 下探后可能低于请求档位。 */
  qualityUsed: CaptureQuality;
  /** `maxBytes` 在最低档仍未达标。 */
  exceedsMaxBytes?: boolean;
  /** 采集自 HDR 屏并已转为 SDR/sRGB。 */
  hdrToneMapped: boolean;
  /** 为满足 H.264 偶数宽高，宽/高被补了 1 像素。 */
  paddedForEvenSize?: boolean;
}

export interface CaptureFailure {
  success: false;
  code: CaptureErrorCode;
  error?: string;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

/** 截图复制位图；录屏（含 GIF）复制原始文件，不返回本地路径。 */
export type CaptureCopyResult =
  | { success: true; kind: 'image' | 'file' }
  | CaptureFailure;

export type CaptureState =
  | "idle"
  | "selecting"
  | "recording"
  | "paused"
  | "encoding";

/** 渲染进程侧可见的桥形状。 */
export interface CaptureBridge {
  /** Explicitly allows selecting another output in the capture UI. Fixed screenshot/record calls keep their semantics. */
  interactive?(options: { action: Exclude<CaptureMenuAction, "webm">; compression?: CaptureCompression; maxDurationMs?: number }): Promise<CaptureResult>;
  /** IM claims a shortcut only while its own composer has focus; grant precedes run. */
  onShortcut?(listener: { canHandle(): boolean; run(action: Exclude<CaptureMenuAction, "webm">): void }): () => void;
  getCapabilities(): Promise<CaptureCapabilities>;
  screenshot(options?: ScreenshotOptions): Promise<CaptureResult>;
  record(options: RecordOptions): Promise<CaptureResult>;
  cancel(): Promise<void>;
  onStateChange(listener: (state: CaptureState) => void): () => void;
  readChunk(
    resultId: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer | null>;
  release(resultId: string): Promise<void>;
  /** 增量能力，旧客户端可缺失；成功复制后可 release 原结果。 */
  copy?(resultId: string): Promise<CaptureCopyResult>;
}
