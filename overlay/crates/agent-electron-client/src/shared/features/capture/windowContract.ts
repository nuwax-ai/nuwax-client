/** Internal native-window contract. Nothing here exposes general IPC or file access. */
export const CAPTURE_WINDOW_CHANNELS = {
  init: 'capture-window:init',
  source: 'capture-window:source',
  finish: 'capture-window:finish',
  action: 'capture-window:action',
  state: 'capture-window:state',
} as const;

export interface CaptureSize { width: number; height: number }
export interface CaptureRect extends CaptureSize { x: number; y: number }
interface CaptureSourceSelection {
  sourceId: string;
  sourceKind: 'screen' | 'window';
  sourceSize: CaptureSize;
  crop: CaptureRect;
  hdrToneMapped: boolean;
}
export type CaptureSelection = CaptureSourceSelection & ({
  coordinateSpace?: 'desktop'; displayBounds: CaptureRect; displayId: string;
} | {
  coordinateSpace: 'source'; displayBounds?: never; displayId?: never;
});
export type RecordingAction = 'pause' | 'resume' | 'stop' | 'cancel';
export interface RecordingControlState {
  state: 'countdown' | 'recording' | 'paused' | 'encoding';
  elapsedMs: number;
  maxDurationMs?: number;
  countdown?: number;
}
export interface RecordingControls {
  update(state: RecordingControlState): void;
  setContentProtection(enabled: boolean): void;
  hideForRecording?(): void;
  dispose(): void;
}
export interface CaptureWindowLabels {
  screenshot: string; screen: string; window: string; region: string; rectangle: string; ellipse: string;
  arrow: string; pen: string; text: string; mosaic: string; undo: string; redo: string;
  cancel: string; confirm: string; record: string; pause: string; resume: string; stop: string;
  countdown: string; recording: string; paused: string; encoding: string; remaining: string;
  selectHint: string; windowSelectHint: string; annotationHint: string; textHint: string; loading: string; loadFailed: string; color: string; lineWidth: string;
  select: string; fontSize: string; deleteAnnotation: string;
  linuxRecordingHint: string;
  entireSource: string;
}
export const DEFAULT_CAPTURE_WINDOW_LABELS: CaptureWindowLabels = {
  screenshot: '截图', screen: '整屏', window: '窗口', region: '区域', rectangle: '矩形', ellipse: '椭圆',
  arrow: '箭头', pen: '画笔', text: '文字', mosaic: '马赛克', undo: '撤销', redo: '重做',
  cancel: '取消', confirm: '确认', record: '开始录制', pause: '暂停', resume: '继续', stop: '停止',
  countdown: '即将录制', recording: '正在录制', paused: '已暂停', encoding: '正在处理',
  remaining: '剩余',
  selectHint: '拖动选择区域 · Esc 取消', windowSelectHint: '单击选择窗口或整屏 · 拖动选择区域 · Esc 取消',
  annotationHint: '点击标注可编辑 · 拖动移动 · Enter 完成',
  textHint: '输入文字', loading: '正在加载窗口…', loadFailed: '无法获取该窗口，请选择其他窗口或区域', color: '颜色', lineWidth: '线条宽度',
  select: '选择与移动', fontSize: '字号', deleteAnnotation: '删除标注',
  linuxRecordingHint: '录制时控制条会隐藏。可用托盘控制，或切回客户端按 Ctrl+Alt+R 停止、Ctrl+Alt+P 暂停/继续。',
  entireSource: '整个来源',
};
export interface CaptureWindowSource {
  id: string; name: string; thumbnail: string; kind: 'screen' | 'window';
}
export interface CaptureWindowImage {
  dataUrl: string; width: number; height: number;
  selection: CaptureSelection;
}
export type CaptureWindowConfiguration = {
  kind: 'selection'; mode: 'still' | 'record'; labels: CaptureWindowLabels;
  image: CaptureWindowImage; sources: CaptureWindowSource[]; workArea: CaptureRect;
  /** Visible top-level windows in frozen-frame pixels, topmost first; absent where desktop geometry is unknown. */
  regions?: CaptureRect[];
  presentation?: 'preview';
  recordingHint?: string;
} | {
  kind: 'controls'; labels: CaptureWindowLabels; state: RecordingControlState;
  presentation?: 'preview';
} | { kind: 'border' };
export interface CaptureWindowBridge {
  init(): Promise<CaptureWindowConfiguration | null>;
  source(id: string): Promise<CaptureWindowImage | null>;
  finish(payload: { crop: CaptureRect; png?: string }): Promise<boolean>;
  action(action: 'cancel' | RecordingAction): void;
  onState(callback: (state: RecordingControlState) => void): () => void;
}
