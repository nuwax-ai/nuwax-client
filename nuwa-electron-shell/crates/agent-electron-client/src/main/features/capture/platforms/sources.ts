import type { CaptureSelection, CaptureSize, CaptureWindowImage } from '@shared/features/capture/windowContract';
import type { RecordingConfig } from '@shared/features/capture/recordingContract';
import type { RecordingSessionWindow } from '../recordingSession';

export interface RecordingSourceContext {
  signal: AbortSignal;
  fps: number;
  framePipeline: RecordingConfig['framePipeline'];
  windows: {
    select(mode: 'record', signal: AbortSignal): Promise<CaptureSelection | null>;
    selectPrepared?(mode: 'record', image: CaptureWindowImage, signal: AbortSignal): Promise<CaptureSelection | null>;
  };
  open(config: RecordingConfig): Promise<RecordingSessionWindow>;
  ready: Promise<CaptureSize>;
  preview: Promise<CaptureWindowImage>;
}

export interface CaptureSourceStrategy {
  readonly providesPreview: boolean;
  readonly acquisitionTimeoutMs: number;
  acquireStill<T>(context: {
    signal: AbortSignal;
    select(): Promise<T | null>;
    selectPrepared(image: CaptureWindowImage): Promise<T | null>;
    capturePortalFrame?: (signal: AbortSignal) => Promise<CaptureWindowImage>;
  }): Promise<T | null>;
  acquireRecording(context: RecordingSourceContext): Promise<{ selection: CaptureSelection; size: CaptureSize } | null>;
}

/** Global desktop coordinates are meaningful only for a directly selected native source. */
export const desktopSource: CaptureSourceStrategy = {
  providesPreview: false,
  acquisitionTimeoutMs: 20000,
  acquireStill: context => context.select(),
  async acquireRecording(context) {
    const selection = await context.windows.select('record', context.signal);
    if (!selection || context.signal.aborted) return null;
    await context.open({ sourceId: selection.sourceId, sourceKind: selection.sourceKind, sourceSize: selection.sourceSize,
      fps: context.fps, mode: 'record', framePipeline: context.framePipeline,
      ...(context.framePipeline==='repeat-last-frame' ? {sourceFrameRateFloor:1} : {}) });
    return { selection, size: await context.ready };
  },
};

/** Authorization, the still preview and recording belong to one PipeWire grant. */
export const portalSource: CaptureSourceStrategy = {
  providesPreview: true,
  acquisitionTimeoutMs: 60000,
  async acquireStill(context) {
    if (!context.capturePortalFrame) throw new Error('Portal snapshot acquisition is unavailable');
    const image = await context.capturePortalFrame(context.signal);
    if (context.signal.aborted) return null;
    return context.selectPrepared(image);
  },
  async acquireRecording(context) {
    if (!context.windows.selectPrepared) throw new Error('Portal source preview is unavailable');
    await context.open(portalRecordingConfig('record', context.fps, context.framePipeline));
    const image = await context.preview;
    const size = await context.ready;
    if (context.signal.aborted) return null;
    const selection = await context.windows.selectPrepared('record', image, context.signal);
    return selection && !context.signal.aborted ? { selection, size } : null;
  },
};

export const portalRecordingConfig = (mode: 'snapshot' | 'record', fps = 30, framePipeline: RecordingConfig['framePipeline'] = 'repeat-last-frame'): RecordingConfig => ({
  sourceId: 'portal', sourceKind: 'screen', sourceSize: { width: 1, height: 1 }, fps, mode,
  acquisition: 'portal', ...(mode === 'record' ? { preview: true, framePipeline } : {}),
  ...(mode==='snapshot' || framePipeline==='repeat-last-frame' ? {sourceFrameRateFloor:1} : {}),
});
