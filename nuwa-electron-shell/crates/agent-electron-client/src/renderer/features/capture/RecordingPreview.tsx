import React from 'react';
import type { CaptureSuccess } from '@shared/features/capture/contract';
import './RecordingPreview.css';

/** Playback uses the browser's accessible media controls; exporting never edits the recording. */
export function RecordingPreview({ result, url, text }: {
  result: CaptureSuccess;
  url: string | null;
  text(key: string): string;
}) {
  const video = result.mime.startsWith('video/');
  const format = result.mime === 'image/gif' ? 'GIF' : result.mime.split('/')[1]?.toUpperCase();
  return <div className="capture-recording-preview">
    <div className="capture-recording-stage">
      {url ? video
        ? <video key={url} src={url} controls playsInline preload="metadata" aria-label={text('recordingPreview')} />
        : <img src={url} alt={text('recordingPreview')} />
        : <p>{text('saveToView')}</p>}
    </div>
    <div className="capture-recording-info">
      <span className="capture-recording-format">{format}</span>
      <span>{result.width} × {result.height}</span>
      <span>{(result.bytes / 1024 / 1024).toFixed(2)} MB</span>
      {result.durationMs !== undefined && <span>{(result.durationMs / 1000).toFixed(1)} s</span>}
      {result.mime === 'image/gif' && <span className="capture-recording-loop">{text('loopPreview')}</span>}
    </div>
    {result.exceedsMaxBytes && <p className="capture-recording-warning">{text('exceedsMaxBytes')}</p>}
  </div>;
}
