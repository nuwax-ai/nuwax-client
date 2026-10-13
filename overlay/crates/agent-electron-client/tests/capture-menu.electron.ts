/**
 * Run on Windows in an interactive desktop, using an isolated Electron runtime.
 * Build from agent-electron-client after overlay sync (output directory must exist):
 * pnpm exec esbuild tests/capture-menu-renderer.tsx --bundle --platform=browser --format=iife --define:process.env.NODE_ENV='"production"' --define:process.env='{"NUWAX_APP_IDENTIFIER":"nuwax","NUWAX_APP_DISPLAY_NAME":"Nuwax","NUWAX_PORT_OFFSET":"1000"}' --outfile=<dir>/capture-menu-renderer.js --tsconfig=tsconfig.json
 * pnpm exec esbuild tests/capture-menu.electron.ts --bundle --platform=node --format=cjs --external:electron --outfile=<dir>/capture-menu.cjs --tsconfig=tsconfig.json
 * electron <dir>/capture-menu.cjs
 * NUWAX_CAPTURE_MENU_OUTPUT controls JSON/PNG evidence directory (default cwd/menu-results).
 * Sends Chromium input only to this fixture's own webContents. No OS input injection.
 */
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = mkdtempSync(path.join(tmpdir(), 'nuwax-menu-fixture-'));
const output = path.resolve(process.env.NUWAX_CAPTURE_MENU_OUTPUT || 'menu-results');
mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), platform: process.platform, versions: process.versions, checks: [] };
let fixture: BrowserWindow | undefined;
let complete = false;
const finish = (error?: unknown) => {
  if (complete) return;
  complete = true;
  clearTimeout(deadline);
  report.ok = !error;
  report.finishedAt = new Date().toISOString();
  if (error) report.error = error instanceof Error ? error.stack : String(error);
  writeFileSync(path.join(output, 'menu-results.json'), JSON.stringify(report, null, 2));
  fixture?.destroy();
  app.exit(error ? 1 : 0);
};
const deadline = setTimeout(() => finish(new Error('Windows menu fixture exceeded 30 seconds')), 30_000);
app.on('will-quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
const pause = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32', 'This fixture must run on real Windows; navigator.platform is never overridden');
  const html = path.join(output, 'capture-menu.html');
  // The external bundle and CSS come from the adjacent build output; no remote resources.
  const renderer = path.join(__dirname, 'capture-menu-renderer.js');
  const css = path.join(__dirname, 'capture-menu-renderer.css');
  const { pathToFileURL } = await import('node:url');
  writeFileSync(html, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; img-src data:; connect-src 'none'"><title>Nuwax menu fixture</title><link rel="stylesheet" href="${pathToFileURL(css).href}"></head><body><div id="root"></div><script src="${pathToFileURL(renderer).href}"></script></body></html>`);
  fixture = new BrowserWindow({ width: 1040, height: 600, frame: false, show: false, backgroundColor: '#f8f9fa', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const window = fixture;
  const consoleMessages: unknown[] = [];
  report.rendererConsole = consoleMessages;
  window.webContents.on('console-message', event => {
    consoleMessages.push({ level: event.level, message: event.message, line: event.lineNumber, sourceId: event.sourceId });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(html);
  window.showInactive();
  const script = <T = any>(source: string): Promise<T> => window.webContents.executeJavaScript(source);
  const until = async (source: string, label: string) => {
    const started = Date.now();
    while (!await script(source)) {
      if (Date.now() - started >= 3000) {
        report.failureDOM = await script('({platform:navigator.platform,body:document.body.innerHTML,state:window.captureMenuFixture})');
        writeFileSync(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
        throw new Error(`${label} timed out`);
      }
      await pause();
    }
  };
  await until('window.captureMenuFixture?.ready === true && document.querySelectorAll(".topbar-menu-btn").length === 6', 'Real toolbar render');
  report.navigatorPlatform = await script('navigator.platform');
  assert.match(String(report.navigatorPlatform), /^Win/i);
  const snapshot = () => script(`(() => ({buttons:[...document.querySelectorAll('.topbar-menu-btn')].map(e=>e.textContent),menus:[...document.querySelectorAll('.topbar-app-menu')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>e.innerText),state:window.captureMenuFixture}))()`);
  const check = async (name: string) => { (report.checks as unknown[]).push({ name, ...(await snapshot()) }); };
  const point = (query: string, text: string) => script<[number, number]>(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(query)})].find(e=>e.textContent.includes(${JSON.stringify(text)})&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');if(!e)throw Error('Missing visible target: '+${JSON.stringify(text)});const r=e.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()`);
  const mouse = async (type: Electron.MouseInputEvent['type'], [x, y]: [number, number]) => {
    window.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
    await pause();
  };
  const hover = async (text: string) => mouse('mouseMove', await point('.topbar-menu-btn', text));
  const menuHas = (text: string) => `(()=>{const menus=[...document.querySelectorAll('.topbar-app-menu')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');return menus.length===1&&menus[0].innerText.includes(${JSON.stringify(text)})})()`;
  await hover('文件');
  await until(menuHas('新建任务'), 'Hover File opens menu without click');
  await check('hover-file-without-click');
  await hover('编辑');
  await until(menuHas('Ctrl+Z'), 'Hover switches File to Edit');
  await pause(220); // A delayed close from File must not close Edit.
  assert.ok(await script(menuHas('Ctrl+Z')), 'Previous popup delayed close must preserve newly hovered menu');
  await check('hover-switch-file-to-edit');
  await hover('截图与录屏');
  await until(menuHas('MP4'), 'Hover Capture opens format menu');
  const captureState = await snapshot();
  for (const text of ['截图', 'MP4', 'WEBM', 'GIF', 'Ctrl+Alt+S', 'Ctrl+Alt+R']) assert.ok(captureState.menus[0].includes(text), `Capture menu includes ${text}`);
  await check('capture-menu-formats-and-shortcuts');
  writeFileSync(path.join(output, 'capture-menu.png'), (await window.webContents.capturePage()).toPNG());
  const position = await point('.topbar-app-menu [role="menuitem"]', 'Ctrl+Alt+S');
  await mouse('mouseMove', position);
  await mouse('mouseDown', position);
  await mouse('mouseUp', position);
  await until('window.captureMenuFixture.calls.length === 1', 'Screenshot dispatch');
  await pause(200);
  const final = await snapshot();
  assert.deepEqual(final.state.calls, [{ action: 'screenshot', visibleMenus: [] }], 'Single callback only after popup hidden');
  assert.deepEqual(final.state.errors, []);
  assert.deepEqual(final.menus, []);
  await check('screenshot-dispatch-after-menu-hidden');
  writeFileSync(path.join(output, 'after-screenshot-menu.png'), (await window.webContents.capturePage()).toPNG());
  finish();
}).catch(finish);
