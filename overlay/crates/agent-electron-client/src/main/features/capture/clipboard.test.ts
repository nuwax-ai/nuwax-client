import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScratchDir } from '../_kit/scratchDir';
import { createResultStore } from './results';
import { CLIPBOARD_TTL_MS, createCaptureClipboard } from './clipboard';
import type { CaptureSuccess } from '@shared/features/capture/contract';

let root: string;
let dispose: (() => void) | undefined;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'nuwax-clipboard-unit-')); });
afterEach(() => { dispose?.(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const results = createResultStore(createScratchDir(path.join(root, 'results')));
  const scratch = createScratchDir(path.join(root, 'clipboard'));
  const platform = { canCopyFiles: true, writeImage: vi.fn(), writeFile: vi.fn(async (_file: string, _signal: AbortSignal): Promise<void> => undefined) };
  const clipboard = createCaptureClipboard(results, scratch, platform); dispose = clipboard.dispose;
  const result = (mime: string): CaptureSuccess => ({ ...results.put(Buffer.from('original bytes'), mime), success: true,
    width: 20, height: 10, qualityUsed: 'high', hdrToneMapped: false });
  return { results, scratch, platform, clipboard, result };
}
describe('复制结果独立于预览租约', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'])('%s 复制位图，成功后清理导出缓存', async mime => {
    const f = fixture(); const r = f.result(mime);
    expect(await f.clipboard.copy(r, new AbortController().signal, () => true)).toEqual({ success: true, kind: 'image' });
    expect(f.platform.writeImage).toHaveBeenCalledOnce(); expect(f.platform.writeFile).not.toHaveBeenCalled();
    expect(readdirSync(f.scratch.root)).toEqual([]); expect(f.results.readChunk(r.resultId, 0, 100)?.toString()).toBe('original bytes');
  });
  it.each([['video/mp4', '.mp4'], ['image/gif', '.gif'], ['video/webm', '.webm']])('%s 复制原文件，release 后字节保持可读并按 TTL 清理', async (mime, extension) => {
    const f = fixture(); const r = f.result(mime);
    expect(await f.clipboard.copy(r, new AbortController().signal, () => true)).toEqual({ success: true, kind: 'file' });
    const exported = f.platform.writeFile.mock.calls[0][0];
    expect(exported.endsWith(extension)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(exported).mode & 0o777).toBe(0o600);
    f.results.release(r.resultId); expect(readFileSync(exported).toString()).toBe('original bytes');
    f.clipboard.dispose(); expect(readFileSync(exported).length).toBe(14);
    const old = new Date(Date.now() - CLIPBOARD_TTL_MS - 5000); utimesSync(path.dirname(exported), old, old);
    expect(f.scratch.sweep(CLIPBOARD_TTL_MS)).toBe(1);
  });
  it('失效句柄和无权上下文不复制，复制失败保留原始结果', async () => {
    const f = fixture(); const r = f.result('image/png');
    expect(await f.clipboard.copy(r, new AbortController().signal, () => false)).toMatchObject({ code: 'canceled' });
    f.platform.writeImage.mockImplementation(() => { throw new Error('clipboard busy'); });
    expect(await f.clipboard.copy(r, new AbortController().signal, () => true)).toMatchObject({ code: 'failed' });
    expect(f.results.readChunk(r.resultId, 0, 100)).not.toBeNull();
    f.results.release(r.resultId);
    expect(await f.clipboard.copy(r, new AbortController().signal, () => true)).toMatchObject({ code: 'invalid-argument' });
    expect(readdirSync(f.scratch.root)).toEqual([]);
  });
  it('复制期间拒绝第二次写入，会话失效时返回 canceled', async () => {
    const f = fixture(); let finish!: () => void;
    f.platform.writeFile.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const controller = new AbortController(); const r = f.result('video/mp4');
    const pending = f.clipboard.copy(r, controller.signal, () => true);
    expect(await f.clipboard.copy(r, controller.signal, () => true)).toMatchObject({ code: 'busy' });
    controller.abort(); finish(); expect(await pending).toMatchObject({ code: 'canceled' });
  });
});
