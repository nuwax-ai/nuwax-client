/** 原生 Electron 40 文件/图片粘贴验收。只处理自建测试媒体，使用隔离 profile。
 * esbuild --bundle --platform=node --format=cjs --external:electron --tsconfig=tsconfig.json
 * 环境 NUWAX_CLIPBOARD_FIXTURE_DIR 提供 sample.mp4 / sample.gif；输出 report.json。
 */
import { app, BrowserWindow, clipboard, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScratchDir } from '@main/features/_kit/scratchDir';
import { createResultStore } from '@main/features/capture/results';
import { createCaptureClipboard } from '@main/features/capture/clipboard';
import { createCaptureClipboardPlatform } from '@main/features/capture/platforms/clipboard';
import type { CaptureSuccess } from '@shared/features/capture/contract';

const root = path.resolve(process.env.NUWAX_CLIPBOARD_FIXTURE_DIR || process.cwd());
const profile = mkdtempSync(path.join(tmpdir(), 'nuwax-clipboard-fixture-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const report: { ok?: boolean; error?: string; platform: string; electron: string; checks: unknown[] } = {
  platform: process.platform, electron: process.versions.electron, checks: [],
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let window: BrowserWindow | undefined;
let exporter: ReturnType<typeof createCaptureClipboard> | undefined;
let done = false;
// 避免保留自建的媒体引用；保留普通文本/图片的原剪贴板内容，无内容写入报告。
let previousText = '';
let previousImage: Electron.NativeImage | undefined;
function finish(error?: unknown) {
  if (done) return; done = true; clearTimeout(deadline);
  report.ok = !error; if (error) report.error = error instanceof Error ? error.stack : String(error);
  exporter?.dispose(); window?.destroy();
  if (previousImage && !previousImage.isEmpty()) clipboard.writeImage(previousImage);
  else if (previousText) clipboard.writeText(previousText);
  else clipboard.clear();
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  rmSync(profile, { recursive: true, force: true });
  app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => finish(new Error('clipboard fixture exceeded 40 seconds')), 40_000);
app.whenReady().then(async () => {
  previousText = clipboard.readText(); previousImage = clipboard.readImage();
  const results = createResultStore(createScratchDir(path.join(profile, 'results')));
  exporter = createCaptureClipboard(results, createScratchDir(path.join(profile, 'clipboard-中文$() #')), createCaptureClipboardPlatform());
  window = new BrowserWindow({ width: 440, height: 240, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<meta charset="utf-8"><p>Nuwax 剪贴板测试</p><div id="paste" contenteditable tabindex="0">仅粘贴测试媒体</div><script>
    window.pasted = null;
    document.addEventListener('paste', async event => {
      event.preventDefault();
      window.pasted = await Promise.all([...event.clipboardData.files].map(async file => ({
        name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())]
      })));
    });
  </script>`)}`);
  window.show(); window.focus();
  const paste = async () => {
    await window!.webContents.executeJavaScript("window.pasted=null;document.getElementById('paste').focus()");
    window!.webContents.paste();
    for (let i = 0; i < 80; i++) {
      const pasted = await window!.webContents.executeJavaScript('window.pasted') as Array<{ name: string; type: string; bytes: number[] }> | null;
      if (pasted) return pasted;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('no native paste event');
  };
  const image = nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 });
  assert.equal(image.isEmpty(), false, 'valid PNG fixture');
  for (const [mime, data] of [
    ['image/png', image.toPNG()], ['image/jpeg', image.toJPEG(90)],
    ['video/mp4', readFileSync(path.join(root, 'sample.mp4'))], ['image/gif', readFileSync(path.join(root, 'sample.gif'))],
  ] as const) {
    const stored = results.put(data, mime);
    const result: CaptureSuccess = { ...stored, success: true, width: 1, height: 1, qualityUsed: 'high', hdrToneMapped: false };
    const copied = await exporter.copy(result, new AbortController().signal, () => true);
    assert.equal(copied.success, true, `${mime} native copy`);
    results.release(result.resultId);
    const formats = clipboard.availableFormats();
    const files = await paste();
    assert.equal(files.length, 1, `${mime} exposes one pasted file`);
    const file = files[0]; const bytes = Buffer.from(file.bytes);
    if (mime === 'video/mp4' || mime === 'image/gif') {
      assert.equal(file.type, mime); assert.equal(hash(bytes), hash(data), `${mime} preserves original bytes after release`);
    } else {
      assert.equal(file.type, 'image/png'); assert.equal(nativeImage.createFromBuffer(bytes).isEmpty(), false);
    }
    report.checks.push({ mime, kind: copied.success ? copied.kind : null, pastedMime: file.type, bytes: bytes.length, formats, releasedBeforePaste: true });
  }
  finish();
}).catch(finish);
