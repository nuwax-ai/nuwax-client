/**
 * Windows interactive-desktop smoke acceptance. No OS/media mocks and no existing client profile.
 * Bundle from agent-electron-client with esbuild --bundle --platform=node --format=cjs --external:electron.
 * Run with cwd containing dist/preload/{captureWindow,captureRecording}.js and resources/capture.
 * NUWAX_CAPTURE_ACCEPTANCE_DIR: evidence directory (default ./capture-windows-results).
 * NUWAX_CAPTURE_RESOURCE_ROOT: verified commercial capture resource root.
 * The only persisted pixels belong to this process's visible test board.
 */
import { app, BrowserWindow, desktopCapturer, nativeImage, screen } from 'electron';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createCaptureService, type CaptureService } from '../src/main/features/capture/captureService';
import { createCaptureSourceStill, createRecordEngine } from '../src/main/features/capture/recorder';
import { resolveCaptureFfmpeg } from '../src/main/features/capture/encodingResources';
import { createCaptureWindows, type CaptureWindows } from '../src/main/features/capture/selectionWindows';
import { createNativeImageEncoder } from '../src/main/features/capture/stillEncoder';
import { createResultStore } from '../src/main/features/capture/results';
import { createScratchDir } from '../src/main/features/_kit/scratchDir';
import type { CaptureResult, CaptureSuccess } from '../src/shared/features/capture/contract';

const output = path.resolve(process.env.NUWAX_CAPTURE_ACCEPTANCE_DIR || 'capture-windows-results');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(path.join(output, 'isolated-profile-'));
const scratchRoot = path.join(profile, 'scratch');
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const delay = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const runFile = promisify(execFile);
const checks: Array<{ name: string; status: 'pass' | 'fail'; elapsedMs: number; detail?: unknown; error?: string }> = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, evidenceDirectory: output, checks };
let windows: CaptureWindows | undefined;
let engine: ReturnType<typeof createRecordEngine> | undefined;
let service: CaptureService | undefined;
let finished = false;
function saveReport() { writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); }
function cleanup() {
  service?.endSession(); engine?.dispose(); windows?.dispose();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
}
const deadline = setTimeout(() => {
  checks.push({ name: 'overall deadline', status: 'fail', elapsedMs: 180000, error: 'Windows capture acceptance exceeded 180 seconds' });
  report.completedAt = new Date().toISOString(); report.success = false;
  cleanup(); saveReport(); console.error(JSON.stringify(report)); app.exit(1);
}, 180_000);
async function until<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read(); if (predicate(value)) return value; await delay();
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function check(name: string, work: () => Promise<unknown>) {
  const start = Date.now();
  try { const detail = await work(); checks.push({ name, status: 'pass', elapsedMs: Date.now() - start, detail }); }
  catch (error) { checks.push({ name, status: 'fail', elapsedMs: Date.now() - start, error: error instanceof Error ? error.stack : String(error) }); service?.cancel(); await delay(150); }
  saveReport(); console.log(JSON.stringify(checks.at(-1)));
}
const js = (win: BrowserWindow, source: string) => win.webContents.executeJavaScript(source, true);
async function clickElement(win: BrowserWindow, selector: string) {
  const point = await js(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing/disabled '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()`);
  for (const type of ['mouseDown', 'mouseUp'] as const) { win.webContents.sendInputEvent({ type, x: point[0], y: point[1], button: 'left', clickCount: 1 }); await delay(); }
}
async function drag(win: BrowserWindow, start: [number, number], end: [number, number]) {
  for (const [type, position] of [['mouseDown', start], ['mouseMove', end], ['mouseUp', end]] as const) {
    win.webContents.sendInputEvent({ type, x: Math.round(position[0]), y: Math.round(position[1]), button: 'left', clickCount: 1 }); await delay();
  }
}
async function key(win: BrowserWindow, keyCode: string) {
  for (const type of ['keyDown', 'keyUp'] as const) win.webContents.sendInputEvent({ type, keyCode }); await delay();
}
function success(result: CaptureResult): CaptureSuccess { assert.equal(result.success, true, JSON.stringify(result)); return result as CaptureSuccess; }
function pixel(image: Electron.NativeImage, x: number, y: number) {
  const size = image.getSize(), data = image.toBitmap(), i = (Math.floor(y) * size.width + Math.floor(x)) * 4;
  return [data[i + 2], data[i + 1], data[i]];
}
function closeTo(actual: number[], expected: number[], tolerance = 45) {
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance), `Expected RGB ${expected}, received ${actual}`);
}

app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32', 'This acceptance harness must run on the actual Windows machine');
  const display = screen.getPrimaryDisplay();
  report.displays = screen.getAllDisplays().map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor }));
  const title = `Nuwax capture acceptance ${process.pid}`;
  const board = new BrowserWindow({ x: display.workArea.x + 32, y: display.workArea.y + 48, width: 640, height: 420,
    useContentSize: true, frame: false, show: false, resizable: false, alwaysOnTop: true, backgroundColor: '#26354b',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const html = `<!doctype html><title>${title}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#26354b;color:white;font:16px sans-serif}.color{position:absolute;top:50px;width:160px;height:130px}.moving{position:absolute;top:265px;width:44px;height:44px;background:#ffe600}#time{position:absolute;left:26px;top:200px}</style><div style="position:absolute;left:26px;top:15px">Nuwax Windows capture acceptance</div><div class="color" style="left:40px;background:#e83232"></div><div class="color" style="left:240px;background:#32d05a"></div><div class="color" style="left:440px;background:#3265e8"></div><div id="time"></div><div class="moving"></div><script>const start=performance.now();function frame(t){document.querySelector('#time').textContent='Elapsed '+((t-start)/1000).toFixed(2)+' s';document.querySelector('.moving').style.left=(40+((t-start)*.19)%510)+'px';requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>`;
  await board.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); board.show(); await delay(700);
  const boardBounds = board.getContentBounds();
  assert.equal(boardBounds.width, 640); assert.equal(boardBounds.height, 420);
  const scratch = createScratchDir(scratchRoot);
  const resultStore = createResultStore(scratch);
  const still = createCaptureSourceStill({ scratch, preloadPath: path.resolve('dist/preload/captureRecording.js') });
  windows = createCaptureWindows({ preloadPath: path.resolve('dist/preload/captureWindow.js'), captureWindowFrame: still, log: console });
  let ffmpeg: Awaited<ReturnType<typeof resolveCaptureFfmpeg>> = null;
  await check('commercial encoder capability probes', async () => {
    ffmpeg = await resolveCaptureFfmpeg({ resourceRoot: path.resolve(process.env.NUWAX_CAPTURE_RESOURCE_ROOT || 'resources/capture') });
    report.encoder = ffmpeg;
    assert.ok(ffmpeg, 'Commercial FFmpeg resource did not pass provenance/hash/configuration checks');
    // Individual unsupported formats are reported by their actual recording checks below.
    return { version: ffmpeg.version, formats: ffmpeg.formats, probeErrors: ffmpeg.probeErrors };
  });
  engine = createRecordEngine({ scratch, windows, ffmpeg, preloadPath: path.resolve('dist/preload/captureRecording.js'), log: console });
  service = createCaptureService({ platform: process.platform, getPermission: () => 'n/a', getDisplays: () => screen.getAllDisplays(),
    stillEngine: windows, recordEngine: engine, stillEncoder: createNativeImageEncoder(), results: resultStore, log: console });
  report.capabilities = service.getCapabilities();
  let sourceId = '';
  await check('OS window enumeration and real source snapshot', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 640, height: 420 } });
    const source = sources.find(source => source.name === title);
    assert.ok(source, 'Visible test-board window is absent from Windows desktopCapturer'); sourceId = source.id;
    const result = await still(sourceId, { width: 640, height: 420 }, new AbortController().signal);
    const image = nativeImage.createFromBuffer(result.png), scale = result.width / 640;
    assert.equal(result.width, Math.round(640 * display.scaleFactor)); assert.equal(result.height, Math.round(420 * display.scaleFactor));
    closeTo(pixel(image, 120 * scale, 110 * scale), [232, 50, 50]);
    closeTo(pixel(image, 320 * scale, 110 * scale), [50, 208, 90]);
    closeTo(pixel(image, 520 * scale, 110 * scale), [50, 101, 232]);
    writeFileSync(path.join(output, 'source-window.png'), result.png);
    return { sourceId, width: result.width, height: result.height, artifact: 'source-window.png' };
  });
  const selectors = async () => {
    const list = await until(() => BrowserWindow.getAllWindows().filter(win => win !== board && !win.isDestroyed() && win.getBounds().width === display.bounds.width), list => list.length > 0, 'native selection windows');
    const current = list.find(win => win.getBounds().x === display.bounds.x && win.getBounds().y === display.bounds.y)!;
    assert.ok(current, 'No native selector on the test board display');
    await until(async () => !current.webContents.isLoadingMainFrame() && await js(current, `Boolean(document.querySelector('.viewport')?.style.width&&document.querySelector('[data-action=window]'))`), Boolean, 'selection renderer initialization');
    report.selectorGeometry = { bounds: current.getBounds(), contentBounds: current.getContentBounds(), viewport: await js(current, '({width:innerWidth,height:innerHeight})') };
    saveReport();
    assert.deepEqual(current.getContentBounds(), display.bounds, 'Selector must cover the full display without Windows work-area clamping');
    return current;
  };
  const selectWindow = async (win: BrowserWindow) => {
    assert.ok(sourceId, 'Test board sourceId unavailable');
    await clickElement(win, '[data-action=window]');
    // Source list may scroll; scroll only this isolated app's own selection element.
    await js(win, `document.querySelector('[data-source="${sourceId}"]').scrollIntoView({block:'center'})`);
    await clickElement(win, `[data-source="${sourceId}"]`);
    await until(() => js(win, `document.querySelector('.sourceGrid').hidden&&document.querySelector('.viewport').classList.contains('fitted')`), Boolean, 'full-resolution test-board source');
  };
  const persist = (result: CaptureSuccess, filename: string) => {
    const destination = path.join(output, filename);
    assert.ok(resultStore.copyTo(result.resultId, destination));
    const data = readFileSync(destination); assert.equal(data.length, result.bytes);
    assert.deepEqual(service!.readChunk(result.resultId, 0, Math.min(result.bytes, 1024)), data.subarray(0, 1024));
    service!.release(result.resultId); assert.equal(service!.readChunk(result.resultId, 0, 16), null);
    return { ...result, resultId: 'released', artifact: filename, sha256: createHash('sha256').update(data).digest('hex') };
  };
  await check('native window selection, text and rectangle annotation, PNG result lifecycle', async () => {
    const pending = service!.screenshot({ format: 'png' });
    try {
      const win = await selectors(); await selectWindow(win);
      const rect = await js(win, `(()=>{const r=document.querySelector('.frame').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
      const p = (x: number, y: number): [number, number] => [rect.x + rect.width * x / 640, rect.y + rect.height * y / 420];
      await clickElement(win, '[data-action=text]'); await drag(win, p(90, 340), p(90, 340));
      assert.equal(await js(win, `document.activeElement.className`), 'textInput', 'Text input must own focus after native mouse click');
      await win.webContents.insertText('Windows 截图验收 T');
      assert.equal(await js(win, `document.querySelector('.textInput').value`), 'Windows 截图验收 T');
      await key(win, 'Enter');
      await clickElement(win, '[data-action=rectangle]'); await drag(win, p(34, 44), p(210, 188));
      const rendered = await js(win, `document.querySelector('.frame').toDataURL()`);
      await clickElement(win, '[data-action=confirm]');
      const result = success(await pending), evidence = persist(result, 'annotated-window.png');
      const image = nativeImage.createFromPath(path.join(output, 'annotated-window.png'));
      assert.deepEqual(image.toBitmap(), nativeImage.createFromDataURL(rendered).toBitmap(), 'Export pixels must match rendered annotation frame, excluding selection handles');
      closeTo(pixel(image, result.width * 0.5, result.height * 110 / 420), [50, 208, 90]);
      return evidence;
    } finally { service!.cancel(); await pending; }
  });
  const region = { x: boardBounds.x + 12, y: boardBounds.y + 12, width: 616, height: 396 };
  const selectRegion = async (win: BrowserWindow) => {
    await drag(win, [region.x - display.bounds.x, region.y - display.bounds.y], [region.x + region.width - display.bounds.x, region.y + region.height - display.bounds.y]);
    await clickElement(win, '[data-action=confirm]');
  };
  const controls = async () => until(async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win !== board && !win.isDestroyed() && !win.webContents.isLoadingMainFrame() && await js(win, `Boolean(document.querySelector('.controlBar'))`).catch(() => false)) return win;
    }
    return null;
  }, value => value !== null, 'recording controls') as Promise<BrowserWindow>;
  const waitState = (state: string) => until(() => service!.getState(), value => value === state, `service state ${state}`);
  const clickAction = async (win: BrowserWindow, name: string) => clickElement(win, name === 'stop' ? '.controlBar button:nth-of-type(2)' : name === 'cancel' ? '.controlBar button:nth-of-type(3)' : `.controlBar button[data-icon=${name}]`);
  // A separate hidden viewer decodes the actual saved products; no fake capture/media input.
  const viewer = new BrowserWindow({ width: 640, height: 420, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const viewerPath = path.join(profile, 'viewer.html'); writeFileSync(viewerPath, '<!doctype html><body></body>'); await viewer.loadFile(viewerPath);
  const frameMetrics = `(canvas)=>{const w=canvas.width,h=canvas.height,c=canvas.getContext('2d'),d=c.getImageData(0,0,w,h).data;const rgb=(x,y)=>{const i=(Math.floor(y)*w+Math.floor(x))*4;return [...d.slice(i,i+3)]};const colors=[120,320,520].map(x=>rgb((x-12)/616*w,(110-12)/396*h));let badEdge=0,edgeCount=0;for(let x=8;x<w-8;x+=17)for(const y of [2,h-3]){const p=rgb(x,y);edgeCount++;if(p.some((v,i)=>Math.abs(v-[38,53,75][i])>50))badEdge++}for(let y=8;y<h-8;y+=17)for(const x of [2,w-3]){const p=rgb(x,y);edgeCount++;if(p.some((v,i)=>Math.abs(v-[38,53,75][i])>50))badEdge++}let movingHash=0;for(let y=Math.floor(h*.62);y<h*.78;y+=3)for(let x=0;x<w;x+=3){const p=rgb(x,y);movingHash=(Math.imul(movingHash,31)+p[0]+p[1]*3+p[2]*7)|0}return {width:w,height:h,colors,badEdge,edgeCount,movingHash}}`;
  const verifyMetrics = (frames: any[]) => {
    assert.ok(frames.length >= 2);
    for (const frame of frames) {
      closeTo(frame.colors[0], [232, 50, 50]); closeTo(frame.colors[1], [50, 208, 90]); closeTo(frame.colors[2], [50, 101, 232]);
      assert.ok(frame.badEdge / frame.edgeCount < .03, `Recording controls/red border polluted frame: ${JSON.stringify(frame)}`);
    }
    assert.ok(new Set(frames.map(frame => frame.movingHash)).size > 1, 'Recorded animation frames are identical');
  };
  for (const format of ['mp4', 'webm', 'gif'] as const) await check(`real ${format.toUpperCase()} region recording, pause/resume/stop, decode/playback`, async () => {
    const capabilities = service!.getCapabilities().formats;
    assert.ok(format === 'gif' ? capabilities.gif : capabilities.video.includes(format), `${format} unavailable: ${JSON.stringify(report.encoder)}`);
    board.show(); await delay(200);
    const states: Array<{ state: string; at: number }> = [];
    const unsubscribe = service!.onStateChange(state => states.push({ state, at: Date.now() }));
    const pending = service!.record({ output: format, fps: 15, compression: { quality: 'high' }, maxDurationMs: 10000 });
    try {
      await selectRegion(await selectors());
      const control = await controls(); await waitState('recording'); await delay(1100);
      await clickAction(control, 'pause'); await waitState('paused');
      const pauseStart = Date.now(); await delay(1000); assert.equal(service!.getState(), 'paused');
      await clickAction(control, 'resume'); await waitState('recording'); await delay(1200);
      await clickAction(control, 'stop');
      const result = success(await pending), evidence = persist(result, `recording.${format}`);
      assert.ok(result.durationMs! >= 2000 && result.durationMs! < 5000, `Active duration incorrect: ${result.durationMs}`);
      assert.equal(result.width, Math.round(region.width * display.scaleFactor)); assert.equal(result.height, Math.round(region.height * display.scaleFactor));
      let decoding: any;
      if (format === 'gif') {
        const base64 = readFileSync(path.join(output, `recording.${format}`)).toString('base64');
        decoding = await js(viewer, `(async()=>{if(!('ImageDecoder'in window))throw Error('Chromium ImageDecoder unavailable');const d=new ImageDecoder({type:'image/gif',data:Uint8Array.from(atob('${base64}'),c=>c.charCodeAt(0))});await d.completed;await d.tracks.ready;const count=d.tracks.selectedTrack.frameCount;if(count<3)throw Error('GIF has too few frames: '+count);const metrics=${frameMetrics};const frames=[];for(const index of [0,Math.min(count-1,Math.floor(count*.7))]){const {image}=await d.decode({frameIndex:index});const canvas=document.createElement('canvas');canvas.width=image.displayWidth;canvas.height=image.displayHeight;canvas.getContext('2d').drawImage(image,0,0);frames.push(metrics(canvas));image.close()}d.close();return {frameCount:count,frames}})()`);
      } else {
        // The commercial build omits null muxer's default wrapped_avframe encoder.
        // Explicitly use its admitted VP9 encoder so this still decodes every input frame.
        const decode = await runFile(ffmpeg!.path, ['-hide_banner', '-v', 'error', '-i', path.join(output, `recording.${format}`), '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-f', 'null', '-'], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
        assert.equal(decode.stderr.trim(), '', 'FFmpeg decode errors');
        decoding = await js(viewer, `(async()=>{const v=document.createElement('video');v.muted=true;v.src=${JSON.stringify(pathToFileURL(path.join(output, `recording.${format}`)).href)};document.body.replaceChildren(v);const event=n=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('video '+n+' timed out')),10000);v.addEventListener(n,()=>{clearTimeout(t);resolve()}, {once:true});v.addEventListener('error',()=>{clearTimeout(t);reject(Error('video error '+v.error?.message))},{once:true})});await event('loadedmetadata');const duration=v.duration;const playing=event('timeupdate');await v.play();await playing;const playbackTime=v.currentTime;v.pause();const metrics=${frameMetrics},frames=[];for(const t of [.25,Math.min(1.75,Number.isFinite(duration)?duration*.7:1.75)]){const seeking=event('seeked');v.currentTime=t;await seeking;const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);frames.push(metrics(c))}v.removeAttribute('src');v.load();return {duration:Number.isFinite(duration)?duration:null,playbackTime,frames,ffmpegDecoded:true}})()`);
        assert.ok(decoding.playbackTime > 0, 'HTML video playback did not advance');
      }
      verifyMetrics(decoding.frames);
      assert.equal(service!.getState(), 'idle');
      return { ...evidence, pauseWallMs: [...states].reverse().find(entry => entry.state === 'recording')!.at - pauseStart, states, decoding };
    } finally { unsubscribe(); service!.cancel(); await pending; }
  });
  await check('recording cancellation and next screenshot reuse', async () => {
    const available = service!.getCapabilities().formats;
    const output = available.video[0] ?? (available.gif ? 'gif' : null);
    assert.ok(output, 'No real recorder format available for cancellation test');
    const pending = service!.record({ output, fps: 15 });
    try { await selectRegion(await selectors()); const control = await controls(); await waitState('recording'); await delay(300); await clickAction(control, 'cancel');
      assert.deepEqual(await pending, { success: false, code: 'canceled' }); assert.equal(service!.getState(), 'idle');
    } finally { service!.cancel(); await pending; }
    const next = service!.screenshot({ format: 'png' });
    try { await selectRegion(await selectors()); const result = success(await next); return persist(result, 'after-cancel.png'); }
    finally { service!.cancel(); await next; }
  });
  await check('capture windows, result handles and scratch cleanup', async () => {
    service!.endSession(); engine!.dispose(); windows!.dispose();
    const unexpected = BrowserWindow.getAllWindows().filter(win => win !== board && win !== viewer && !win.isDestroyed());
    assert.equal(unexpected.length, 0, 'Capture-owned windows remained after cleanup');
    assert.deepEqual(readdirSync(scratchRoot), [], 'Temporary capture/session/result data remained after release');
    return { leakedWindows: unexpected.length, remainingScratchEntries: 0 };
  });
}).catch(error => {
  checks.push({ name: 'harness setup', status: 'fail', elapsedMs: 0, error: error instanceof Error ? error.stack : String(error) });
}).finally(async () => {
  if (finished) return; finished = true; clearTimeout(deadline); cleanup();
  report.completedAt = new Date().toISOString(); report.success = checks.length > 0 && checks.every(check => check.status === 'pass');
  // Chromium can retain profile file handles until process exit; scratch must already be empty.
  try { rmSync(profile, { recursive: true, force: true }); report.profileRemoved = true; }
  catch (error) { report.profileRemoved = false; report.profileCleanup = String(error); }
  saveReport(); console.log(JSON.stringify(report)); app.exit(report.success ? 0 : 1);
});
