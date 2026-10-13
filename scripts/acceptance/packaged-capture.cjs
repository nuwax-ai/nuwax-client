/**
 * Run the INSTALLED ASAR main/preloads/IPC in a matching Electron runtime.
 * This tests packaged defaults, including process.resourcesPath/capture.
 * It does not bundle source or substitute a capture implementation.
 *
 * On an active Windows desktop:
 *   set NUWAX_QA_RESOURCES=C:\Users\...\Programs\Nuwax\resources
 *   set NUWAX_QA_CAPTURE_OUTPUT=C:\...\packaged-capture-results
 *   set NUWAX_QA_CAPTURE_MODE=full
 *   electron.exe scripts\acceptance\packaged-capture.cjs
 * MODE defaults to capabilities; full also records/saves/plays MP4/WebM/GIF.
 * No existing profile, ticket or account is opened. Only the process's own
 * test board is persisted. Save-dialog automation is confined to this process.
 */
const { app, BrowserWindow, dialog, nativeImage, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { installChildProcessTracking } = require('./child-process-tracking.cjs');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const resources = process.env.NUWAX_QA_RESOURCES;
const output = process.env.NUWAX_QA_CAPTURE_OUTPUT;
if (!resources || !output || !path.isAbsolute(resources) || !path.isAbsolute(output)) {
  throw Error('Set absolute NUWAX_QA_RESOURCES and NUWAX_QA_CAPTURE_OUTPUT');
}
const asar = path.join(resources, 'app.asar');
const mainPath = path.join(asar, 'dist/main/main.js');
const metadata = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'));
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'empty-profile-'));
const appData = path.join(profile, 'appdata');
const sessionData = path.join(profile, 'sessiondata');
for (const dir of [appData, sessionData, path.join(appData, 'Nuwax'), path.join(profile, '.nuwax')]) fs.mkdirSync(dir, { recursive: true });
app.setPath('home', profile);
app.setPath('appData', appData);
app.setPath('sessionData', sessionData);
app.setPath('userData', path.join(appData, 'Nuwax'));
// Some startup helpers use os.homedir rather than Electron's home path.
// Keep those reads in this same fresh profile without changing HOME/USERPROFILE.
os.homedir = () => profile;
for (const key of ['NUWAX_SAVED_KEY', 'NUWAX_SERVER_HOST', 'NUWAX_USER_NAME', 'NUWAX_WORKSPACE_DIR', 'NUWAX_LOOPBACK']) delete process.env[key];
Object.defineProperty(app, 'isPackaged', { get: () => true });
Object.defineProperty(process, 'resourcesPath', { value: resources });
app.getAppPath = () => asar;
app.getVersion = () => metadata.version;

const checks = [];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { startedAt: new Date().toISOString(), mode: process.env.NUWAX_QA_CAPTURE_MODE || 'capabilities',
  mainPid: process.pid,
  platform: process.platform, electron: process.versions.electron, packageVersion: metadata.version,
  actualAsar: asar, mainSha256: digest(mainPath), resources, profile, checks,
  scope: 'Installed ASAR main/preloads/IPC and packaged resource defaults in matching Electron; isolated empty data; no installer or existing account acceptance' };
let host;
let board;
let destination;
let finished = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (win, source) => win.webContents.executeJavaScript(source, true);
const bridge = source => js(host, `window.electronAPI.capture.${source}`);
const writeReport = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
const children = [];
let closingChildren = false;
function writeProcesses() {
  fs.writeFileSync(path.join(output, 'process-ids.json'), JSON.stringify({ mainPid: process.pid, profile, startedAt: report.startedAt, children }, null, 2));
}
const { originals } = installChildProcessTracking(childProcess, {
  isClosing: () => closingChildren,
  onChild(child, method, args) {
    // Record executable basenames only. Commands, arguments and environments may
    // contain account data and are deliberately absent from the PID ledger.
    const entry = { method, executable: method === 'exec' ? 'shell-command' : path.basename(String(args[0])),
      pid: child.pid || null, startedAt: new Date().toISOString(), parentPid: process.pid };
    children.push(entry); writeProcesses();
    child.once('spawn', () => { entry.pid = child.pid; writeProcesses(); });
    child.once('exit', (code, signal) => { entry.endedAt = new Date().toISOString(); entry.exitCode = code; entry.signal = signal; writeProcesses(); });
    child.once('error', error => { entry.errorCode = error.code || 'error'; writeProcesses(); });
  },
});
writeProcesses();
if (process.env.NUWAX_QA_CHILD_CLEANUP_FIXTURE === '1' && process.platform === 'win32') {
  childProcess.spawn('cmd.exe', ['/d', '/s', '/c', 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90"'],
    { windowsHide: true, stdio: 'ignore' });
}
async function cleanupOwnChildren() {
  closingChildren = true;
  if (process.platform !== 'win32') throw Error('Packaged capture child cleanup is Windows-only');
  // The still-live test main PID anchors ownership. A process is admitted only
  // when its parent is this PID and its creation is newer than the main process.
  // taskkill /T removes each admitted root's descendants. Before every kill,
  // recheck creation time and parent PID to reject a recycled PID. Chromium's
  // own child processes are left to app.exit, avoiding GPU respawn during test
  // teardown. This does not inspect names/ports to select unrelated processes.
  const runtimeName = path.basename(process.execPath).replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'
$taskRootPid=${process.pid}
$runtimeName='${runtimeName}'
$main=Get-CimInstance Win32_Process -Filter "ProcessId=$taskRootPid"
if(!$main){throw 'Own test main process no longer exists'}
$before=@();$killed=@();$remaining=@()
for($pass=0;$pass -lt 2;$pass++){
  $snapshot=@(Get-CimInstance Win32_Process)
  $roots=@($snapshot | Where-Object { $_.ParentProcessId -eq $taskRootPid -and $_.ProcessId -ne $PID -and $_.Name -ne $runtimeName -and $_.CreationDate -ge $main.CreationDate })
  foreach($root in $roots){
    $queue=@($root)
    while($queue.Count){
      $parent=$queue[0];$queue=@($queue | Select-Object -Skip 1)
      $before+=@{pid=[int]$parent.ProcessId;parentPid=[int]$parent.ParentProcessId;name=$parent.Name;createdAt=$parent.CreationDate.ToUniversalTime().ToString('o')}
      $queue+=@($snapshot | Where-Object { $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate })
    }
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($root.ProcessId)"
    if(!$current){continue}
    if($current.ParentProcessId -ne $taskRootPid -or $current.CreationDate -ne $root.CreationDate){throw 'Child PID ownership changed during cleanup'}
    $previousPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
    $null=& "$env:SystemRoot\\System32\\taskkill.exe" /PID $root.ProcessId /T /F 2>&1
    $killed+=@{pid=[int]$root.ProcessId;exitCode=$LASTEXITCODE}
    $ErrorActionPreference=$previousPreference
  }
  Start-Sleep -Milliseconds 250
}
$remaining=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$taskRootPid" | Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne $runtimeName -and $_.CreationDate -ge $main.CreationDate } | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;createdAt=$_.CreationDate.ToUniversalTime().ToString('o')} })
foreach($seen in $before){
  $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($seen.pid)"
  if($current -and $current.CreationDate.ToUniversalTime().ToString('o') -eq $seen.createdAt){$remaining+=@($seen)}
}
@{ownerPid=$taskRootPid;helperPid=$PID;before=$before;killed=$killed;remaining=$remaining} | ConvertTo-Json -Depth 5 -Compress`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const stdout = await new Promise((resolve, reject) => originals.execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  report.childCleanup = JSON.parse(stdout.trim()); report.childProcesses = children;
  assert.equal(report.childCleanup.remaining.length, 0, 'Owned bootstrap subprocesses remained after cleanup');
  writeProcesses();
}
async function finish(code) {
  if (finished) return;
  finished = true;
  if (host && !host.isDestroyed()) await bridge('cancel()').catch(() => {});
  // Destroy only windows in this test process. Their recovery handlers then
  // cannot recreate renderer workers while its bootstrap children are stopped.
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  try { await cleanupOwnChildren(); checks.push({ name: 'owned child-process cleanup', status: 'pass', detail: report.childCleanup }); }
  catch (error) { checks.push({ name: 'owned child-process cleanup', status: 'fail', error: error.message }); code = 1; }
  report.completedAt = new Date().toISOString(); report.success = code === 0;
  writeReport(); console.log('PACKAGED_CAPTURE_RESULT', JSON.stringify(report));
  // Product quit cleanup globally sweeps same-product CUA daemons on Windows.
  // Fresh profile never starts device services; exit this test process directly
  // after capture cleanup, preserving the user's running device/CUA services.
  app.exit(code);
}
async function until(read, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(80); }
  throw Error(`Timeout: ${label}`);
}
async function check(name, run) {
  const start = Date.now();
  try { const detail = await run(); checks.push({ name, status: 'pass', elapsedMs: Date.now() - start, detail }); }
  catch (error) { checks.push({ name, status: 'fail', elapsedMs: Date.now() - start, error: error.stack || String(error) });
    if (host && !host.isDestroyed()) await bridge('cancel()').catch(() => {}); }
  writeReport(); console.log(JSON.stringify(checks.at(-1)));
}
async function findWindow(selector) {
  return until(async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win === host || win === board || win.isDestroyed() || win.webContents.isLoadingMainFrame()) continue;
      if (await js(win, `Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)) return win;
    }
  }, selector);
}
async function click(win, selector) {
  const p = await js(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing/disabled element');const r=e.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()`);
  for (const type of ['mouseDown', 'mouseUp']) { win.webContents.sendInputEvent({ type, x: p[0], y: p[1], button: 'left', clickCount: 1 }); await delay(60); }
}
async function startCapture(key, expression) {
  await js(host, `(()=>{window.__captureQa=window.__captureQa||{};window.__captureQa[${JSON.stringify(key)}]={states:[]};const current=window.__captureQa[${JSON.stringify(key)}];current.off=window.electronAPI.capture.onStateChange(state=>{current.state=state;current.states.push({state,at:Date.now()})});void ${expression}.then(result=>{current.result=result;current.done=true;current.off()},error=>{current.result={success:false,error:String(error)};current.done=true;current.off()})})()`);
}
async function selectRegion(region, display) {
  const selector = await until(async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win === host || win === board || win.webContents.isLoadingMainFrame()) continue;
      const bounds = win.getBounds();
      if (bounds.x === display.bounds.x && bounds.y === display.bounds.y &&
          await js(win, 'Boolean(document.querySelector("[data-action=confirm]"))').catch(() => false)) return win;
    }
  }, 'selector on test-board display');
  await until(() => js(selector, "Boolean(document.querySelector('.viewport')?.style.width)"), 'selector initialized');
  const start = { x: Math.round(region.x - display.bounds.x), y: Math.round(region.y - display.bounds.y) };
  const end = { x: start.x + region.width, y: start.y + region.height };
  for (const [type, point] of [['mouseDown', start], ['mouseMove', end], ['mouseUp', end]]) {
    selector.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 }); await delay(70);
  }
  await click(selector, '[data-action=confirm]');
}
async function state(key, value) {
  return until(() => js(host, `window.__captureQa[${JSON.stringify(key)}].state===${JSON.stringify(value)}`), `capture ${value}`);
}
async function persist(key, filename) {
  const result = await until(() => js(host, `window.__captureQa[${JSON.stringify(key)}].done&&window.__captureQa[${JSON.stringify(key)}].result`), 'capture result', 45000);
  assert.equal(result.success, true, JSON.stringify(result));
  destination = path.join(output, filename);
  assert.equal((await bridge(`save(${JSON.stringify(result.resultId)})`)).success, true);
  const bytes = fs.readFileSync(destination); assert.equal(bytes.length, result.bytes);
  const prefix = await bridge(`readChunk(${JSON.stringify(result.resultId)},0,64).then(b=>b?Array.from(new Uint8Array(b)):null)`);
  assert.deepEqual(prefix, [...bytes.subarray(0, 64)]);
  await bridge(`release(${JSON.stringify(result.resultId)})`);
  assert.equal(await bridge(`readChunk(${JSON.stringify(result.resultId)},0,64)`), null);
  return { ...result, resultId: 'released', file: filename, sha256: digest(destination), states: await js(host, `window.__captureQa[${JSON.stringify(key)}].states`) };
}
function verifyColors(colors) {
  const expected = [[232, 50, 50], [50, 208, 90], [50, 101, 232]];
  colors.forEach((color, i) => assert.ok(color.every((value, channel) => Math.abs(value - expected[i][channel]) < 65),
    `Saved test-board color differs: ${JSON.stringify(colors)}`));
}
const frameMetrics = `(image)=>{const c=document.createElement('canvas');c.width=image.displayWidth||image.videoWidth;c.height=image.displayHeight||image.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;const rgb=(x,y)=>{const i=(Math.floor(y)*c.width+Math.floor(x))*4;return [...data.slice(i,i+3)]};const colors=[120,320,520].map(x=>rgb((x-12)/616*c.width,(110-12)/396*c.height));let motionHash=0;for(let y=Math.floor(c.height*.62);y<c.height*.78;y+=3)for(let x=0;x<c.width;x+=3){const p=rgb(x,y);motionHash=(Math.imul(motionHash,31)+p[0]+p[1]*3+p[2]*7)|0}return {colors,motionHash}}`;

setTimeout(() => { checks.push({ name: 'deadline', status: 'fail', error: 'Exceeded 240 seconds' }); void finish(1); }, 240000).unref();
require(mainPath);
app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32');
  host = await until(async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isLoadingMainFrame()) continue;
      if (await js(win, 'Boolean(window.electronAPI?.capture)').catch(() => false)) return win;
    }
  }, 'installed host preload/bridge', 60000);
  dialog.showSaveDialog = async () => { assert.ok(destination); return { canceled: false, filePath: destination }; };
  await check('installed ASAR host bridge and default packaged encoder capabilities', async () => {
    report.capabilities = await bridge('getCapabilities()');
    assert.equal(report.capabilities.available, true);
    assert.deepEqual([...report.capabilities.formats.video].sort(), ['mp4', 'webm']);
    assert.equal(report.capabilities.formats.gif, true);
    assert.ok(app.getPath('userData').startsWith(profile)); assert.ok(app.getPath('home').startsWith(profile));
    report.loopback = await js(host, 'window.electronAPI.settings.get("nuwax.loopback")');
    assert.equal(report.loopback?.enabled, false, 'Fresh packaged profile must use direct mode and not bind a shared loopback port');
    return report.capabilities;
  });
  if (report.mode !== 'full') return finish(checks.some(c => c.status === 'fail') ? 1 : 0);
  const display = screen.getPrimaryDisplay();
  report.displays = screen.getAllDisplays().map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor }));
  board = new BrowserWindow({ x: display.workArea.x + 32, y: display.workArea.y + 48, width: 640, height: 420,
    frame: false, useContentSize: true, resizable: false, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await board.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Nuwax packaged capture QA</title><style>html,body{margin:0;background:#26354b;color:white;font:16px sans-serif}.c{position:absolute;top:50px;width:160px;height:130px}#m{position:absolute;top:265px;width:44px;height:44px;background:#ffe600}</style><div style="position:absolute;left:26px;top:15px">Installed package capture QA</div><div class=c style="left:40px;background:#e83232"></div><div class=c style="left:240px;background:#32d05a"></div><div class=c style="left:440px;background:#3265e8"></div><div id=m></div><script>function frame(t){document.querySelector("#m").style.left=(40+t*.19%510)+"px";requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>'));
  board.show(); await delay(500);
  const bounds = board.getContentBounds();
  const region = { x: bounds.x + 12, y: bounds.y + 12, width: 616, height: 396 };
  await check('installed screenshot API, native selection, host save/read/release', async () => {
    await startCapture('png', 'window.electronAPI.capture.screenshot({format:"png"})');
    await selectRegion(region, display); const result = await persist('png', 'screenshot.png');
    const image = nativeImage.createFromPath(path.join(output, 'screenshot.png'));
    assert.equal(image.isEmpty(), false);
    const size = image.getSize(), pixels = image.toBitmap();
    result.colors = [120, 320, 520].map(x => { const i = (Math.floor((110 - 12) / 396 * size.height) * size.width + Math.floor((x - 12) / 616 * size.width)) * 4; return [pixels[i + 2], pixels[i + 1], pixels[i]]; });
    verifyColors(result.colors); return result;
  });
  const viewer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const viewerFile = path.join(profile, 'viewer.html'); fs.writeFileSync(viewerFile, '<!doctype html><body></body>'); await viewer.loadFile(viewerFile);
  for (const format of ['mp4', 'webm', 'gif']) await check(`installed ${format} recording, pause/resume, host save, Chromium playback`, async () => {
    board.show(); await delay(200);
    await startCapture(format, `window.electronAPI.capture.record({output:${JSON.stringify(format)},fps:15,maxDurationMs:12000})`);
    await selectRegion(region, display);
    const controls = await findWindow('.controlBar'); await state(format, 'recording'); await delay(1100);
    await click(controls, '.controlBar button[data-icon=pause]'); await state(format, 'paused'); await delay(1000);
    await click(controls, '.controlBar button[data-icon=resume]'); await state(format, 'recording'); await delay(1200);
    await click(controls, '.controlBar button:nth-of-type(2)');
    const result = await persist(format, `recording.${format}`);
    assert.ok(result.durationMs >= 2000 && result.durationMs < 5000);
    assert.equal(result.width, Math.round(region.width * display.scaleFactor)); assert.equal(result.height, Math.round(region.height * display.scaleFactor));
    if (format === 'gif') {
      const base64 = fs.readFileSync(path.join(output, `recording.${format}`)).toString('base64');
      result.playback = await js(viewer, `(async()=>{const d=new ImageDecoder({type:'image/gif',data:Uint8Array.from(atob('${base64}'),c=>c.charCodeAt(0))});await d.completed;await d.tracks.ready;const frameCount=d.tracks.selectedTrack.frameCount;const first=await d.decode({frameIndex:0});const last=await d.decode({frameIndex:frameCount-1});const dimensions=[first.image.displayWidth,first.image.displayHeight],metrics=${frameMetrics},frames=[metrics(first.image),metrics(last.image)];first.image.close();last.image.close();d.close();return {frameCount,dimensions,frames}})()`);
      assert.ok(result.playback.frameCount >= 3);
    } else {
      result.playback = await js(viewer, `(async()=>{const v=document.createElement('video');v.muted=true;document.body.replaceChildren(v);const event=n=>new Promise((r,j)=>{const t=setTimeout(()=>j(Error(n+' timeout')),10000);v.addEventListener(n,()=>{clearTimeout(t);r()},{once:true});v.addEventListener('error',()=>{clearTimeout(t);j(Error(v.error?.message))},{once:true})});const loaded=event('loadedmetadata');v.src=${JSON.stringify(pathToFileURL(path.join(output, `recording.${format}`)).href)};await loaded;const tick=event('timeupdate');await v.play();await tick;v.pause();const currentTime=v.currentTime,metrics=${frameMetrics},frames=[];for(const t of [.25,1.75]){const seeked=event('seeked');v.currentTime=t;await seeked;frames.push(metrics(v))}return {width:v.videoWidth,height:v.videoHeight,currentTime,duration:Number.isFinite(v.duration)?v.duration:null,frames}})()`);
      assert.ok(result.playback.currentTime > 0); assert.equal(result.playback.width, result.width); assert.equal(result.playback.height, result.height);
    }
    for (const frame of result.playback.frames) verifyColors(frame.colors);
    assert.notEqual(result.playback.frames[0].motionHash, result.playback.frames[1].motionHash, 'Recorded animation frames must differ');
    return result;
  });
  await finish(checks.some(c => c.status === 'fail') ? 1 : 0);
}).catch(error => { checks.push({ name: 'startup', status: 'fail', error: error.stack || String(error) }); void finish(1); });
