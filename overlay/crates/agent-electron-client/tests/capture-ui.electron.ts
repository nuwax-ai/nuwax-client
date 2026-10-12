/**
 * 原生输入回归：在隔离的隐藏 Electron 窗口中使用真实 Chromium 鼠标/键盘事件。
 * 从 agent-electron-client 目录运行（先 build:main:dev 生成 preload）：
 * pnpm exec esbuild tests/capture-ui.electron.ts --bundle --platform=node --format=cjs --external:electron --outfile=/tmp/nuwax-capture-ui.cjs --tsconfig=tsconfig.json
 * pnpm exec electron /tmp/nuwax-capture-ui.cjs
 */
import { app, BrowserWindow, desktopCapturer, nativeImage, screen } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCaptureWindows } from '../src/main/features/capture/selectionWindows';

const profile = mkdtempSync(path.join(tmpdir(), 'nuwax-capture-ui-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
app.on('will-quit', () => rmSync(profile, { recursive: true, force: true }));
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
const delay = () => new Promise(resolve => setTimeout(resolve, 30));
const deadline = setTimeout(() => { console.error('Capture UI regression timed out'); app.exit(1); }, 40_000);

app.whenReady().then(async () => {
  app.dock?.hide();
  // 仅替换此测试进程的展示行为，不操作用户正在验收的客户端或实际显示器。
  BrowserWindow.prototype.show = function () {};
  BrowserWindow.prototype.showInactive = function () {};
  BrowserWindow.prototype.focus = function () {};
  let image = nativeImage.createFromBitmap(Buffer.alloc(1920 * 1200 * 4, 255), { width: 1920, height: 1200 });
  const displays = [0, -960, 960].map((x, index) => ({
    id: index + 1, bounds: { x, y: 0, width: 960, height: 600 }, size: { width: 960, height: 600 }, scaleFactor: 2,
    workArea: { x, y: 0, width: 960, height: 600 },
  } as Electron.Display));
  screen.getAllDisplays = () => displays;
  screen.getDisplayNearestPoint = () => displays[0];
  desktopCapturer.getSources = async opts => opts.types.includes('screen') ? displays.map(display => ({
    id: `screen:${display.id}`, name: 'Synthetic display', display_id: String(display.id), thumbnail: image, appIcon: null,
  })) : [];
  const windows = createCaptureWindows({ preloadPath: path.resolve('dist/preload/captureWindow.js') });
  const prepared = async () => {
    while (BrowserWindow.getAllWindows().length !== 3) await delay();
    const selectors = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id);
    for (const selector of selectors) {
      while (selector.webContents.isLoadingMainFrame()) await delay();
      await selector.webContents.executeJavaScript(`new Promise(resolve=>{const check=()=>document.querySelector('.frame')?.width===1920?resolve(true):setTimeout(check,10);check()})`);
    }
    return selectors;
  };
  const mouse = async (selector: BrowserWindow, type: Electron.MouseInputEvent['type'], x: number, y: number) => {
    selector.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
    await delay();
  };
  const click = async (selector: BrowserWindow, x: number, y: number) => {
    await mouse(selector, 'mouseDown', x, y); await mouse(selector, 'mouseUp', x, y);
  };
  const key = async (selector: BrowserWindow, keyCode: string) => {
    selector.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    selector.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await delay();
  };
  const script = (selector: BrowserWindow, source: string) => selector.webContents.executeJavaScript(source);
  const tool = (selector: BrowserWindow, name: string) => script(selector, `document.querySelector('[data-action=${name}]').click()`);
  const editing = (selector: BrowserWindow) => script(selector, `({focused:document.activeElement.className,display:document.querySelector('.textInput').style.display,value:document.querySelector('.textInput').value})`);
  const frame = (selector: BrowserWindow) => script(selector, `document.querySelector('.frame').toDataURL()`);
  const drag = async (selector: BrowserWindow, from: [number, number], to: [number, number]) => {
    await mouse(selector, 'mouseDown', ...from); await mouse(selector, 'mouseMove', ...to); await mouse(selector, 'mouseUp', ...to);
  };

  let pending = windows.captureStill(new AbortController().signal);
  const selectors = await prepared();
  for (let i = 0; i < selectors.length; i++) {
    if (i) await mouse(selectors[i - 1], 'mouseLeave', -1, 100);
    await mouse(selectors[i], 'mouseMove', 100, 100);
    const visible = await Promise.all(selectors.map(selector => script(selector, `!document.querySelector('.magnifier').hidden`)));
    assert.deepEqual(visible, selectors.map((_, index) => index === i), '跨屏后只能保留当前屏幕的放大框');
  }
  await script(selectors[2], `window.dispatchEvent(new Event('blur'))`);
  assert.equal(await script(selectors[2], `document.querySelector('.magnifier').hidden`), true);

  const current = selectors[0];
  await mouse(current, 'mouseDown', 80, 80);
  await mouse(current, 'mouseMove', 700, 400);
  await mouse(current, 'mouseUp', 700, 400);
  await tool(current, 'text'); await click(current, 100, 100);
  assert.deepEqual(await editing(current), { focused: 'textInput', display: 'block', value: '' }, '真实点击后输入框必须保持焦点');
  current.webContents.sendInputEvent({ type: 'char', keyCode: 'T' }); await delay();
  await current.webContents.insertText('文字 Test');
  assert.equal((await editing(current)).value, 'T文字 Test');
  await script(current, `document.querySelector('.textInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  assert.equal((await editing(current)).display, 'block', '输入法确认候选词不能结束编辑');
  await key(current, 'Enter');
  assert.equal(current.isDestroyed(), false, '文字 Enter 不能确认整张截图');
  assert.equal((await editing(current)).display, 'none');
  await tool(current, 'undo');
  assert.equal(await script(current, `document.querySelector('[data-action=undo]').disabled`), true, '失焦和 Enter 不能重复保存同一条文字');
  await tool(current, 'redo');
  await click(current, 320, 170); await current.webContents.insertText('第二段');
  await click(current, 530, 230); await current.webContents.insertText('丢弃');
  await key(current, 'Escape');
  assert.equal(current.isDestroyed(), false, '第一次 Escape 只取消当前文字编辑');
  await tool(current, 'confirm');
  const result = await pending;
  assert.ok(result); assert.deepEqual(result.image.getSize(), { width: 1240, height: 640 });
  const bitmap = result.image.toBitmap();
  const redIn = (left: number, top: number, right: number, bottom: number) => {
    let count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const offset = (y * 1240 + x) * 4;
      if (bitmap[offset] === 82 && bitmap[offset + 1] === 59 && bitmap[offset + 2] === 255) count++;
    }
    return count;
  };
  assert.ok(redIn(40, 40, 450, 105) > 20, '第一段文字应写入 PNG');
  assert.ok(redIn(480, 180, 780, 245) > 20, '点击新位置前应保存上一段文字');
  assert.equal(redIn(900, 300, 1200, 365), 0, '取消的文字不能写入 PNG');

  pending = windows.captureStill(new AbortController().signal);
  const next = (await prepared())[0];
  await tool(next, 'screen'); await delay(); await tool(next, 'text'); await click(next, 100, 100);
  await next.webContents.insertText('直接确认');
  await tool(next, 'confirm');
  const directlyConfirmed = await pending;
  assert.ok(directlyConfirmed);
  const directBitmap = directlyConfirmed.image.toBitmap();
  let directRed = 0;
  for (let i = 0; i < directBitmap.length; i += 4) {
    if (directBitmap[i] === 82 && directBitmap[i + 1] === 59 && directBitmap[i + 2] === 255) directRed++;
  }
  assert.ok(directRed > 20, '直接确认截图也必须提交仍在编辑的文字');

  pending = windows.captureStill(new AbortController().signal);
  const textWindow = (await prepared())[1];
  await tool(textWindow, 'screen'); await delay(); await tool(textWindow, 'text'); await click(textWindow, 100, 100);
  await textWindow.webContents.insertText('原文字'); await key(textWindow, 'Enter');
  const originalText = await frame(textWindow);
  await click(textWindow, 108, 108);
  assert.equal((await editing(textWindow)).value, '原文字', '点击已有文字必须载入原内容');
  await textWindow.webContents.insertText('修改完成'); await key(textWindow, 'Enter');
  const editedText = await frame(textWindow); assert.notEqual(editedText, originalText);
  await click(textWindow, 108, 108); assert.equal((await editing(textWindow)).value, '修改完成');
  await textWindow.webContents.insertText('取消本次修改'); await key(textWindow, 'Escape');
  assert.equal(await frame(textWindow), editedText, '取消重编辑必须恢复原内容');
  await click(textWindow, 108, 108); await key(textWindow, 'Enter');
  await tool(textWindow, 'undo'); assert.equal(await frame(textWindow), originalText, '不改内容的再次确认不能增加历史');
  await tool(textWindow, 'redo'); assert.equal(await frame(textWindow), editedText);
  await click(textWindow, 108, 108); await key(textWindow, 'Enter');
  const fontPoint = await script(textWindow, `(()=>{const r=document.querySelector('[data-action=fontSize]').getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()`);
  await click(textWindow, fontPoint[0], fontPoint[1]);
  await script(textWindow, `document.querySelector('[data-action=fontSize]').select()`);
  await textWindow.webContents.insertText('32'); await key(textWindow, 'Tab');
  const resizedText = await frame(textWindow); assert.notEqual(resizedText, editedText, '字号修改必须改变实际画布');
  await tool(textWindow, 'undo'); assert.equal(await frame(textWindow), editedText);
  await tool(textWindow, 'redo'); assert.equal(await frame(textWindow), resizedText);
  await drag(textWindow, [108, 108], [158, 138]);
  const movedText = await frame(textWindow); assert.notEqual(movedText, resizedText, '拖动文字应移动对象而非开启空输入框');
  await tool(textWindow, 'undo'); assert.equal(await frame(textWindow), resizedText);
  await tool(textWindow, 'redo'); assert.equal(await frame(textWindow), movedText);
  const expectedText = nativeImage.createFromDataURL(movedText).toBitmap();
  await tool(textWindow, 'confirm');
  const textResult = await pending; assert.ok(textResult);
  assert.equal(textResult.image.toBitmap().equals(expectedText), true, '导出应包含修改后的文字与字号，不能包含选中框');

  // 棋盘背景让马赛克的移动、缩放也能通过真实像素变化来验证。
  const checker = Buffer.alloc(1920 * 1200 * 4, 255);
  for (let y = 0; y < 1200; y++) for (let x = 0; x < 1920; x++) {
    const offset = (y * 1920 + x) * 4, shade = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 ? 220 : 80;
    checker[offset] = checker[offset + 1] = checker[offset + 2] = shade;
  }
  image = nativeImage.createFromBitmap(checker, { width: 1920, height: 1200 });
  for (const name of ['rectangle', 'ellipse', 'arrow', 'pen', 'mosaic']) {
    pending = windows.captureStill(new AbortController().signal);
    const shapeWindow = (await prepared())[2];
    await tool(shapeWindow, 'screen'); await delay();
    const blank = await frame(shapeWindow);
    await tool(shapeWindow, name); await drag(shapeWindow, [100, 100], [220, 180]);
    const drawn = await frame(shapeWindow); assert.notEqual(drawn, blank, name);
    await drag(shapeWindow, [160, 140], [220, 190]);
    const moved = await frame(shapeWindow); assert.notEqual(moved, drawn, `${name} should move`);
    await tool(shapeWindow, 'undo'); assert.equal(await frame(shapeWindow), drawn);
    await tool(shapeWindow, 'redo'); assert.equal(await frame(shapeWindow), moved);
    await click(shapeWindow, 220, 190);
    await drag(shapeWindow, [280, 230], [320, 270]);
    const resized = await frame(shapeWindow); assert.notEqual(resized, moved, `${name} should resize`);
    await script(shapeWindow, `(()=>{const input=document.querySelector('input[type=range]');input.value='6';input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));})()`);
    if (name !== 'mosaic') await script(shapeWindow, `(()=>{const input=document.querySelector('input[type=color]');input.value='#0088ff';input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));})()`);
    const styled = await frame(shapeWindow); assert.notEqual(styled, resized, `${name} should update its style`);
    await tool(shapeWindow, 'deleteAnnotation'); assert.equal(await frame(shapeWindow), blank, `${name} should be removable`);
    await tool(shapeWindow, 'undo'); assert.equal(await frame(shapeWindow), styled, `${name} deletion should undo`);
    const expected = nativeImage.createFromDataURL(styled).toBitmap();
    if (name !== 'mosaic') {
      let blue = 0;
      for (let i = 0; i < expected.length; i += 4) if (expected[i] === 255 && expected[i + 1] === 136 && expected[i + 2] === 0) blue++;
      assert.ok(blue > 20, `${name} should use the edited color`);
    }
    await tool(shapeWindow, 'confirm'); const shapeResult = await pending; assert.ok(shapeResult);
    assert.equal(shapeResult.image.toBitmap().equals(expected), true, `${name} export should match the edited pixels`);
    console.log('PASS edit annotation', name);
  }

  pending = windows.captureStill(new AbortController().signal);
  await key((await prepared())[2], 'Escape');
  assert.equal(await pending, null); assert.equal(BrowserWindow.getAllWindows().length, 0);
  windows.dispose(); clearTimeout(deadline);
  console.log('PASS capture UI: text re-edit/font size, shape editing, undo/redo, PNG, three-display magnifier');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
