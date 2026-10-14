import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CaptureCopyResult, CaptureSuccess } from '@shared/features/capture/contract';
import type { ScratchDir } from '../_kit/scratchDir';
import type { ResultStore } from './results';
import type { CaptureClipboardPlatform } from './platforms/clipboard/types';

export const CLIPBOARD_TTL_MS = 24 * 60 * 60 * 1000;
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'image/gif': 'gif',
};

/** 剪贴板有独立的租约；释放预览/退出会话不删除已成功复制的文件。 */
export function createCaptureClipboard(results: ResultStore, scratch: ScratchDir, platform: CaptureClipboardPlatform) {
  let busy = false;
  const sweep = () => { try { scratch.sweep(CLIPBOARD_TTL_MS); } catch { /* 缓存不可访问不能中断采集或退出。 */ } };
  sweep();
  const cleanup = setInterval(sweep, 60 * 60 * 1000);
  cleanup.unref();
  return {
    dispose() { clearInterval(cleanup); },
    async copy(result: CaptureSuccess, signal: AbortSignal, isCurrent: () => boolean): Promise<CaptureCopyResult> {
      const extension = EXTENSIONS[result.mime];
      const kind = result.mime.startsWith('image/') && result.mime !== 'image/gif' ? 'image' : 'file';
      if (!extension) return { success: false, code: 'unsupported' };
      if (kind === 'file' && !platform.canCopyFiles) return { success: false, code: 'unsupported' };
      if (busy) return { success: false, code: 'busy' };
      if (signal.aborted || !isCurrent()) return { success: false, code: 'canceled' };
      busy = true;
      const id = `clipboard-${randomBytes(16).toString('hex')}`;
      let retained = false;
      try {
        sweep();
        const filePath = path.join(scratch.create(id), `Nuwax.${extension}`);
        if (!results.copyTo(result.resultId, filePath)) return { success: false, code: 'invalid-argument' };
        fs.chmodSync(filePath, 0o600);
        if (signal.aborted || !isCurrent()) return { success: false, code: 'canceled' };
        if (kind === 'image') platform.writeImage(filePath);
        else {
          // 子进程可能在取消前已经发布文件引用；这类副本也交由 TTL 清理。
          retained = true;
          await platform.writeFile(filePath, signal);
        }
        if (signal.aborted || !isCurrent()) return { success: false, code: 'canceled' };
        return { success: true, kind };
      } catch {
        return { success: false, code: signal.aborted ? 'canceled' : 'failed' };
      } finally {
        if (!retained) scratch.remove(id);
        busy = false;
      }
    },
  };
}
