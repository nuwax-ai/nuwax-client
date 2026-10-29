/**
 * 原生输入回归：在隔离的隐藏 Electron 窗口中使用真实 Chromium 鼠标/键盘事件。
 * 从 agent-electron-client 目录运行（先 build:main:dev 生成 preload）：
 * pnpm exec esbuild tests/capture-ui.electron.ts --bundle --platform=node --format=cjs --external:electron --outfile=/tmp/nuwax-capture-ui.cjs --tsconfig=tsconfig.json
 * pnpm exec electron /tmp/nuwax-capture-ui.cjs
 */
import { app, BrowserWindow, desktopCapturer, dialog, nativeImage, screen } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCaptureWindows } from '../src/main/features/capture/selectionWindows';

const profile = mkdtempSync(path.join(tmpdir(), 'nuwax-capture-ui-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const removeProfile = () => {
  // Windows 可能直到进程退出才释放 Chromium 的 profile 文件句柄。
  try { rmSync(profile, { recursive: true, force: true }); }
  catch (error) { console.warn(`Capture UI profile cleanup deferred: ${profile}`, String(error)); }
};
app.on('will-quit', removeProfile);
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
const delay = () => new Promise(resolve => setTimeout(resolve, 30));
const deadline = setTimeout(() => { console.error('Capture UI regression timed out'); app.exit(1); }, 40_000);

app.whenReady().then(async () => {
  app.dock?.hide();
  const realDisplays = screen.getAllDisplays().map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor }));
  const fixtureOrigin = screen.getPrimaryDisplay().workArea;
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
      // 三屏是配置隔离测试。隐藏窗口重叠放在真实屏内，避免输入测试依赖
      // 真机桌面的屏幕拓扑；保持各轮原始尺寸，不据此声称做了物理多屏验收。
      selector.setBounds({ x: fixtureOrigin.x, y: fixtureOrigin.y });
      while (selector.webContents.isLoadingMainFrame()) await delay();
      await selector.webContents.executeJavaScript(`new Promise(resolve=>{const check=()=>document.querySelector('.frame')?.width===1920?resolve(true):setTimeout(check,10);check()})`);
      // 等待隐藏 renderer 的合成帧，使 Chromium 有可命中的输入 surface。
      await selector.webContents.capturePage();
      await selector.webContents.executeJavaScript(`window.__captureInputEvents=[];for(const type of ['pointermove','pointerleave','mousemove','mouseleave','blur'])window.addEventListener(type,event=>{window.__captureInputEvents.push({type,target:event.target?.className,x:event.clientX,y:event.clientY});if(window.__captureInputEvents.length>12)window.__captureInputEvents.shift()},true)`);
    }
    return selectors;
  };
  const mouse = async (selector: BrowserWindow, type: Electron.MouseInputEvent['type'], x: number, y: number) => {
    selector.webContents.focus();
    selector.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
    await delay();
  };
  const click = async (selector: BrowserWindow, x: number, y: number) => {
    await mouse(selector, 'mouseDown', x, y); await mouse(selector, 'mouseUp', x, y);
  };
  const key = async (selector: BrowserWindow, keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []) => {
    selector.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter' && !modifiers?.length && !selector.isDestroyed()) selector.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    if (!selector.isDestroyed()) selector.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay();
  };
  const script = (selector: BrowserWindow, source: string) => selector.webContents.executeJavaScript(source);
  const tool = (selector: BrowserWindow, name: string) => script(selector, `document.querySelector('[data-action=${name}]').click()`);
  const editing = (selector: BrowserWindow) => script(selector, `({focused:document.activeElement.className,display:document.querySelector('.textInput').style.display,value:document.querySelector('.textInput').value})`);
  const frame = (selector: BrowserWindow) => script(selector, `document.querySelector('.frame').toDataURL()`);
  const drag = async (selector: BrowserWindow, from: [number, number], to: [number, number]) => {
    await mouse(selector, 'mouseDown', ...from); await mouse(selector, 'mouseMove', ...to); await mouse(selector, 'mouseUp', ...to);
  };
  const clickControl = async (selector: BrowserWindow, query: string) => {
    const point = await script(selector, `(()=>{const r=document.querySelector(${JSON.stringify(query)}).getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()`);
    await click(selector, point[0], point[1]);
  };
  const visible = (selector: BrowserWindow, query: string) => script(selector, `(()=>{const e=document.querySelector(${JSON.stringify(query)});return Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden')})()`);
  const checkDock = async (selector: BrowserWindow) => {
    const layout = await script(selector, `(()=>({width:innerWidth,height:innerHeight,controls:[...document.querySelectorAll('.selectionDock button,.selectionDock input')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>{const r=e.getBoundingClientRect();return {name:e.dataset.action||e.dataset.color||e.dataset.size||e.type,x:r.x,y:r.y,right:r.right,bottom:r.bottom}})}))()`);
    assert.ok(layout.controls.length > 10, '布局检查必须覆盖实际展开的工具面板');
    for (const control of layout.controls) {
      assert.ok(control.x >= 0 && control.y >= 0 && control.right <= layout.width && control.bottom <= layout.height, `工具 ${control.name} 必须留在 ${layout.width}×${layout.height} 视口内: ${JSON.stringify(control)}`);
    }
    for (let i = 0; i < layout.controls.length; i++) for (let j = i + 1; j < layout.controls.length; j++) {
      const a = layout.controls[i], b = layout.controls[j];
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      assert.ok(overlapWidth <= 1 || overlapHeight <= 1, `工具 ${a.name} 与 ${b.name} 不能相互遮挡`);
    }
  };
  // 仅在显式指定目录时保存合成画面的截图，不采集用户桌面。
  const saveScreenshot = async (selector: BrowserWindow, name: string) => {
    if (!process.env.NUWAX_CAPTURE_UI_SCREENSHOTS) return;
    await mouse(selector, 'mouseLeave', -1, -1);
    const directory = path.resolve(process.env.NUWAX_CAPTURE_UI_SCREENSHOTS);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${name}.png`), (await selector.webContents.capturePage()).toPNG());
    if (name === 'interactive-modes') {
      const dock = await script(selector, `(()=>{const r=document.querySelector('.selectionDock').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);
      writeFileSync(path.join(directory, 'mode-picker.png'), (await selector.webContents.capturePage(dock)).toPNG());
    }
  };

  let pending = windows.captureStill(new AbortController().signal);
  const selectors = await prepared();
  for (let i = 0; i < selectors.length; i++) {
    if (i) await mouse(selectors[i - 1], 'mouseLeave', -1, 100);
    await mouse(selectors[i], 'mouseMove', 100, 100);
    const visible = await Promise.all(selectors.map(selector => script(selector, `!document.querySelector('.magnifier').hidden`)));
    const diagnostics = await Promise.all(selectors.map(async selector => ({ bounds: selector.getBounds(), contentBounds: selector.getContentBounds(),
      page: await script(selector, `({width:innerWidth,height:innerHeight,frame:document.querySelector('.frame').getBoundingClientRect().toJSON(),events:window.__captureInputEvents})`) })));
    assert.deepEqual(visible, selectors.map((_, index) => index === i), `跨屏后只能保留当前屏幕的放大框: ${JSON.stringify({ realDisplays, diagnostics })}`);
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
  assert.equal((await editing(current)).display, 'block', 'Enter 应换行并保持文字编辑');
  assert.equal((await editing(current)).value, 'T文字 Test\n');
  await current.webContents.insertText('第二行\n\n第四行');
  assert.equal((await editing(current)).value, 'T文字 Test\n第二行\n\n第四行');
  await key(current, 'Enter', ['control']);
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
  await clickControl(next, '.swatch[data-color="#36d5ae"]');
  await clickControl(next, '.fontPreset[data-size="24"]');
  assert.deepEqual(await editing(next), { focused: 'textInput', display: 'block', value: '直接确认' }, '输入中点击颜色/字号快捷按钮应保持输入焦点与未提交文字');
  await next.webContents.insertText('继续输入');
  assert.equal((await editing(next)).value, '直接确认继续输入');
  await clickControl(next, '.swatch[data-color="#ff3b52"]');
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
  await textWindow.webContents.insertText('原文字'); await key(textWindow, 'Enter', ['control']);
  const originalText = await frame(textWindow);
  await click(textWindow, 108, 108);
  assert.equal((await editing(textWindow)).value, '原文字', '点击已有文字必须载入原内容');
  await textWindow.webContents.insertText('修改完成'); await key(textWindow, 'Enter', ['control']);
  const editedText = await frame(textWindow); assert.notEqual(editedText, originalText);
  await click(textWindow, 108, 108); assert.equal((await editing(textWindow)).value, '修改完成');
  await textWindow.webContents.insertText('取消本次修改'); await key(textWindow, 'Escape');
  assert.equal(await frame(textWindow), editedText, '取消重编辑必须恢复原内容');
  await click(textWindow, 108, 108); await key(textWindow, 'Enter', ['control']);
  await tool(textWindow, 'undo'); assert.equal(await frame(textWindow), originalText, '不改内容的再次确认不能增加历史');
  await tool(textWindow, 'redo'); assert.equal(await frame(textWindow), editedText);
  await click(textWindow, 108, 108); await key(textWindow, 'Enter', ['control']);
  const fontPoint = await script(textWindow, `(()=>{const r=document.querySelector('[data-action=fontSize]').getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()`);
  await click(textWindow, fontPoint[0], fontPoint[1]);
  await script(textWindow, `document.querySelector('[data-action=fontSize]').select()`);
  await textWindow.webContents.insertText('32'); await key(textWindow, 'Tab');
  const resizedText = await frame(textWindow); assert.notEqual(resizedText, editedText, '字号修改必须改变实际画布');
  await tool(textWindow, 'undo'); assert.equal(await frame(textWindow), editedText);
  await tool(textWindow, 'redo'); assert.equal(await frame(textWindow), resizedText);
  await click(textWindow, 108, 108); await key(textWindow, 'Enter', ['control']);
  await clickControl(textWindow, '.fontPreset[data-size="24"]');
  const presetText = await frame(textWindow); assert.notEqual(presetText, resizedText, '字号快捷按钮必须修改已选中的文字');
  assert.equal(await script(textWindow, `document.querySelector('[data-action=fontSize]').value`), '24');
  await tool(textWindow, 'undo'); assert.equal(await frame(textWindow), resizedText, '字号快捷修改必须可撤销');
  await tool(textWindow, 'redo'); assert.equal(await frame(textWindow), presetText);
  await drag(textWindow, [108, 108], [158, 138]);
  const movedText = await frame(textWindow); assert.notEqual(movedText, presetText, '拖动文字应移动对象而非开启空输入框');
  await tool(textWindow, 'undo'); assert.equal(await frame(textWindow), presetText);
  await tool(textWindow, 'redo'); assert.equal(await frame(textWindow), movedText);
  await click(textWindow, 158, 138); await key(textWindow, 'Enter', ['control']);
  assert.equal(await visible(textWindow, '.fontSizeControl'), true);
  assert.equal(await visible(textWindow, '.widthControl'), false, '文字工具不应显示线宽');
  await checkDock(textWindow); await saveScreenshot(textWindow, 'annotation-text');
  const expectedText = nativeImage.createFromDataURL(movedText).toBitmap();
  await tool(textWindow, 'confirm');
  const textResult = await pending; assert.ok(textResult);
  assert.equal(textResult.image.toBitmap().equals(expectedText), true, '导出应包含修改后的文字与字号，不能包含选中框');

  // 原生保存面板只在本测试进程中替换；PNG 经真实可信窗口桥写入隔离目录。
  const nativeSave = dialog.showSaveDialog;
  const saveDirectory = process.env.NUWAX_CAPTURE_UI_SCREENSHOTS ? path.resolve(process.env.NUWAX_CAPTURE_UI_SCREENSHOTS) : profile;
  mkdirSync(saveDirectory, { recursive: true });
  const savedPath = path.join(saveDirectory, 'saved-multiline.png');
  let saveRequests = 0;
  dialog.showSaveDialog = (async () => {
    saveRequests++;
    return saveRequests === 1 ? { canceled: true }
      : { canceled: false, filePath: saveRequests === 2 ? path.join(profile, 'missing-directory', 'screenshot.png') : savedPath };
  }) as typeof dialog.showSaveDialog;
  try {
    pending = windows.captureStill(new AbortController().signal);
    const saving = (await prepared())[0];
    await drag(saving, [80, 80], [700, 400]);
    await tool(saving, 'text'); await click(saving, 100, 100);
    await saving.webContents.insertText('第一行'); await key(saving, 'Enter');
    await saving.webContents.insertText('第二行\n\n第四行');
    await key(saving, 'Enter', process.platform === 'darwin' ? ['meta'] : ['control']);
    const expected = await frame(saving);
    assert.deepEqual(await script(saving, `[...document.querySelector('.actionGroup').children].map(b=>b.dataset.action)`), ['save', 'cancel', 'confirm'], '保存必须紧邻取消左侧');
    await clickControl(saving, '[data-action=save]');
    assert.equal(saving.isDestroyed(), false, '取消保存面板后保留截图选区');
    assert.equal(await script(saving, `document.querySelector('[data-action=save]').disabled`), false, '取消保存后解除互斥锁');
    assert.equal(await frame(saving), expected, '取消保存不能丢失多行文字或画面');
    await clickControl(saving, '[data-action=save]');
    await script(saving, `new Promise(resolve=>{const check=()=>!document.querySelector('[data-action=save]').disabled?resolve(true):setTimeout(check,10);check()})`);
    assert.equal(await script(saving, `document.querySelector('.hint').textContent`), '保存失败，请重试');
    assert.equal(await script(saving, `document.querySelector('.hint').getBoundingClientRect().bottom <= document.querySelector('.selectionDock').getBoundingClientRect().top`), true, '保存错误必须在工具栏外可读');
    assert.equal(await frame(saving), expected, '写入失败后保留标注并可重试');
    await saveScreenshot(saving, 'multiline-save-toolbar');
    await clickControl(saving, '[data-action=save]');
    const saved = await pending; assert.ok(saved); assert.equal(saveRequests, 3);
    const savedImage = nativeImage.createFromBuffer(readFileSync(savedPath));
    assert.deepEqual(savedImage.getSize(), { width: 1240, height: 640 });
    assert.equal(savedImage.toBitmap().equals(saved.image.toBitmap()), true, '磁盘 PNG 必须与最终选区和多行标注逐像素相同');
    const savedPixels = savedImage.toBitmap();
    const hasRed = (top: number, bottom: number) => {
      for (let y = top; y < bottom; y++) for (let x = 40; x < 400; x++) {
        const offset = (y * 1240 + x) * 4;
        if (savedPixels[offset] === 82 && savedPixels[offset + 1] === 59 && savedPixels[offset + 2] === 255) return true;
      }
      return false;
    };
    assert.ok(hasRed(40, 70) && hasRed(75, 105) && hasRed(140, 172), 'PNG 必须包含换行后的第一、二、四行');
    assert.equal(hasRed(110, 138), false, '空行必须保留');
    console.log('PASS toolbar PNG save, cancellation, failed write/retry and multiline pixels');
  } finally { dialog.showSaveDialog = nativeSave; }

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
    if (name === 'rectangle') {
      await clickControl(shapeWindow, '.swatch[data-color="#36d5ae"]');
      const recolored = await frame(shapeWindow); assert.notEqual(recolored, styled, '颜色快捷按钮必须修改选中图形的实际像素');
      const pixels = nativeImage.createFromDataURL(recolored).toBitmap();
      let green = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 174 && pixels[i + 1] === 213 && pixels[i + 2] === 54) green++;
      assert.ok(green > 20, '图形应使用快捷按钮的绿色');
      await tool(shapeWindow, 'undo'); assert.equal(await frame(shapeWindow), styled, '颜色快捷修改必须可撤销');
      await click(shapeWindow, 220, 190);
      await checkDock(shapeWindow); await saveScreenshot(shapeWindow, 'annotation-shape');
    }
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

  // 独立的窄屏/底边选区场景，不改变前面原始图像尺寸与导出像素断言。
  for (const display of displays) {
    display.bounds.width = display.size.width = display.workArea.width = 480;
  }
  pending = windows.captureStill(new AbortController().signal);
  const narrow = (await prepared())[2];
  await drag(narrow, [410, 500], [470, 570]);
  assert.equal(await script(narrow, 'innerWidth'), 480);
  await tool(narrow, 'select');
  assert.equal(await visible(narrow, '.toolbar.properties'), false, '未选中对象的选择工具应隐藏样式行');
  await tool(narrow, 'text');
  assert.equal(await visible(narrow, '.toolbar.properties'), true);
  assert.equal(await visible(narrow, '.fontSizeControl'), true);
  assert.equal(await visible(narrow, '.widthControl'), false);
  await checkDock(narrow); await saveScreenshot(narrow, 'annotation-narrow');
  await tool(narrow, 'mosaic');
  assert.equal(await visible(narrow, '.palette'), false, '马赛克应隐藏颜色选择');
  assert.equal(await visible(narrow, '.fontSizeControl'), false);
  assert.equal(await visible(narrow, '.widthControl'), true);
  await checkDock(narrow);
  await tool(narrow, 'rectangle');
  assert.equal(await visible(narrow, '.palette'), true);
  assert.equal(await visible(narrow, '.fontSizeControl'), false);
  assert.equal(await visible(narrow, '.widthControl'), true);
  await checkDock(narrow);
  await tool(narrow, 'select');
  await key(narrow, 'Escape');
  assert.equal(await pending, null); assert.equal(BrowserWindow.getAllWindows().length, 0);

  for (const display of displays) display.bounds.width = display.size.width = display.workArea.width = 960;
  windows.setActions('screenshot', ['screenshot', 'mp4', 'gif']);
  const changed = windows.captureStill(new AbortController().signal).catch(error => error);
  const interactive = (await prepared())[0];
  await drag(interactive, [120, 120], [400, 300]);
  const selectedDimensions = await script(interactive, `document.querySelector('.dimensions').textContent`);
  assert.equal(await script(interactive, `document.querySelectorAll('.captureTabs button').length`), 2, '顶部只提供截图与录屏两个模式');
  await tool(interactive, 'mode-record');
  assert.equal(await visible(interactive, '.toolbar.tools'), false, '录屏模式隐藏标注工具');
  assert.equal(await script(interactive, `document.querySelector('[data-action=confirm]').textContent`), '开始录制');
  assert.equal(await visible(interactive, '.recordingPanel'), true);
  assert.deepEqual(await script(interactive, `[...document.querySelectorAll('.formatOptions button')].map(e=>e.textContent)`), ['MP4', 'GIF']);
  await saveScreenshot(interactive, 'recording-settings');
  await tool(interactive, 'mode-screenshot');
  assert.equal(await visible(interactive, '.toolbar.tools'), true);
  assert.equal(await script(interactive, `document.querySelector('.dimensions').textContent`), selectedDimensions, '切换模式保留选区');
  await checkDock(interactive); await saveScreenshot(interactive, 'interactive-modes');
  await tool(interactive, 'mode-record');
  await clickControl(interactive, '[data-action=format-gif]');
  assert.equal(await script(interactive, `document.querySelector('[data-action=format-gif]').getAttribute('aria-checked')`), 'true');
  await tool(interactive, 'mode-screenshot'); await tool(interactive, 'mode-record');
  assert.equal(await script(interactive, `document.querySelector('[data-action=format-gif]').getAttribute('aria-checked')`), 'true', '切换模式保留上次选择的录屏格式');
  await tool(interactive, 'confirm');
  const chosen = await changed;
  assert.equal(chosen.action, 'gif');
  assert.equal(`${chosen.selected.crop.width} × ${chosen.selected.crop.height} px`, selectedDimensions);
  windows.setActions('screenshot', []);
  console.log('PASS interactive screenshot/MP4/GIF mode tabs preserve crop');

  // 用真实 Chromium 输入调整裁剪范围，覆盖八个方向、移动、取消调整及最终导出。
  pending = windows.captureStill(new AbortController().signal);
  const adjustable = (await prepared())[0];
  await drag(adjustable, [120, 120], [400, 300]);
  await tool(adjustable, 'rectangle'); await drag(adjustable, [180, 160], [220, 190]);
  await click(adjustable, 270, 220); // 取消标注选中，保留选择工具。
  const annotated = await frame(adjustable);
  const adjustments: Array<{ from: [number, number]; to: [number, number]; size: string }> = [
    { from: [120, 120], to: [100, 100], size: '600 × 400 px' },
    { from: [250, 100], to: [250, 90], size: '600 × 420 px' },
    { from: [400, 90], to: [420, 80], size: '640 × 440 px' },
    { from: [420, 190], to: [440, 190], size: '680 × 440 px' },
    { from: [440, 300], to: [460, 320], size: '720 × 480 px' },
    { from: [280, 320], to: [280, 340], size: '720 × 520 px' },
    { from: [100, 340], to: [90, 360], size: '740 × 560 px' },
    { from: [90, 220], to: [80, 220], size: '760 × 560 px' },
  ];
  for (const adjustment of adjustments) {
    await drag(adjustable, adjustment.from, adjustment.to);
    assert.equal(await script(adjustable, `document.querySelector('.dimensions').textContent`), adjustment.size);
    assert.equal(await frame(adjustable), annotated, '调整裁剪范围不能缩放或移动已有标注');
  }
  await mouse(adjustable, 'mouseDown', 460, 360);
  await script(adjustable, `document.querySelector('.mask').onpointermove(new PointerEvent('pointermove',{clientX:2000,clientY:2000}))`);
  assert.equal(await script(adjustable, `document.querySelector('.dimensions').textContent`), '1760 × 1040 px', '选框不能超出来源像素');
  await key(adjustable, 'Escape'); await mouse(adjustable, 'mouseUp', 460, 360);
  await mouse(adjustable, 'mouseDown', 460, 360); await mouse(adjustable, 'mouseMove', 0, 0);
  assert.equal(await script(adjustable, `document.querySelector('.dimensions').textContent`), '1 × 1 px', '跨过对边时保持至少一个像素');
  await key(adjustable, 'Escape'); await mouse(adjustable, 'mouseUp', 0, 0);
  await mouse(adjustable, 'mouseDown', 80, 80); await mouse(adjustable, 'mouseMove', 100, 100);
  await script(adjustable, `document.querySelector('.mask').dispatchEvent(new PointerEvent('pointercancel'))`);
  await mouse(adjustable, 'mouseUp', 100, 100);
  assert.equal(await script(adjustable, `document.querySelector('.dimensions').textContent`), '760 × 560 px', '系统取消拖拽时恢复原范围');
  await drag(adjustable, [150, 150], [160, 160]);
  assert.equal(await frame(adjustable), annotated, '移动选框不能移动已有标注');
  await mouse(adjustable, 'mouseDown', 90, 90); await mouse(adjustable, 'mouseMove', 60, 60);
  await key(adjustable, 'Enter');
  assert.equal(BrowserWindow.getAllWindows().length, 3, '拖拽期间 Enter 不应提交选区');
  await key(adjustable, 'Escape'); await mouse(adjustable, 'mouseUp', 60, 60);
  assert.equal(await script(adjustable, `document.querySelector('.dimensions').textContent`), '760 × 560 px', 'Esc 撤销本次调整');
  await checkDock(adjustable); await saveScreenshot(adjustable, 'adjustable-selection');
  await tool(adjustable, 'confirm');
  const adjusted = await pending; assert.ok(adjusted);
  assert.deepEqual(adjusted.image.getSize(), { width: 760, height: 560 });
  const expectedCrop = nativeImage.createFromDataURL(annotated).crop({ x: 180, y: 180, width: 760, height: 560 });
  assert.ok(adjusted.image.toBitmap().equals(expectedCrop.toBitmap()), '导出像素应来自移动后的最终范围');

  for (const action of ['mp4', 'gif'] as const) {
    windows.setActions('screenshot', ['screenshot', 'mp4', 'gif']);
    const changed = windows.captureStill(new AbortController().signal).catch(error => error);
    const selector = (await prepared())[0];
    await drag(selector, [120, 120], [400, 300]);
    await tool(selector, 'mode-record');
    await clickControl(selector, `[data-action=format-${action}]`);
    await drag(selector, [400, 300], [440, 320]);
    await drag(selector, [200, 200], [220, 210]);
    await tool(selector, 'confirm');
    const chosen = await changed;
    assert.equal(chosen.action, action);
    assert.deepEqual(chosen.selected.crop, { x: 280, y: 260, width: 640, height: 400 });
  }
  windows.setActions('screenshot', []);
  console.log('PASS screenshot crop resize in eight directions, move, cancel, annotation preservation and MP4/GIF final crops');

  for (const stage of ['empty', 'text', 'record-selection'] as const) {
    const controller = new AbortController();
    const canceled = stage === 'record-selection' ? windows.select('record', controller.signal) : windows.captureStill(controller.signal);
    const selector = (await prepared())[2];
    if (stage === 'text') {
      await tool(selector, 'screen'); await tool(selector, 'text'); await click(selector, 100, 100);
      await selector.webContents.insertText('右键取消不能提交');
    }
    let contextMenus = 0;
    selector.webContents.on('context-menu', () => { contextMenus++; });
    selector.webContents.focus();
    const location = stage === 'text' ? { x: 110, y: 110 } : { x: 100, y: 100 };
    selector.webContents.sendInputEvent({ type: 'mouseDown', ...location, button: 'right', clickCount: 1 });
    selector.webContents.sendInputEvent({ type: 'mouseUp', ...location, button: 'right', clickCount: 1 });
    const result = await Promise.race([canceled, new Promise(resolve => setTimeout(() => resolve('timeout'), 1000))]);
    controller.abort();
    assert.equal(result, null, `${stage} 右键应直接取消整次捕获`);
    assert.equal(contextMenus, 0, '右键不能弹出上下文菜单');
    assert.equal(BrowserWindow.getAllWindows().length, 0, '右键应关闭全部屏幕的选区窗口');
  }
  console.log('PASS right-click cancels empty, text-editing and recording selections across all synthetic displays');

  // 只创建隔离的控制条/区域边框，不开启媒体流或真实录屏。
  const recordingActions: string[] = [];
  const recordingControls = windows.createRecordingControls({
    sourceId: 'screen:1', sourceKind: 'screen', sourceSize: { width: 1920, height: 1200 },
    crop: { x: 160, y: 160, width: 1280, height: 640 }, displayBounds: { ...displays[0].bounds },
    displayId: '1', hdrToneMapped: false,
  }, action => { recordingActions.push(action); });
  try {
    await delay(); // 工厂在微任务中导航，先等待这次导航开始。
    const [controlWindow, borderWindow] = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id);
    for (const [window, className] of [[controlWindow, 'controlBody'], [borderWindow, 'border']] as const) {
      while (window.webContents.isLoadingMainFrame()) await delay();
      await script(window, `new Promise(resolve=>{const check=()=>document.body.classList.contains('${className}')?resolve(true):setTimeout(check,10);check()})`);
    }
    await controlWindow.webContents.capturePage();
    controlWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'right', clickCount: 1 });
    controlWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'right', clickCount: 1 });
    await delay();
    assert.deepEqual(recordingActions, [], '录制控制条右键不能误取消或停止录屏');
    assert.equal(await script(borderWindow, `getComputedStyle(document.body).borderRadius`), '0px', '录制区域边框必须保持直角');
    for (const state of ['recording', 'paused', 'encoding'] as const) {
      recordingControls.update({ state, elapsedMs: 65_000 });
      await script(controlWindow, `new Promise(resolve=>{const check=()=>document.querySelector('.controlBar').dataset.state==='${state}'?resolve(true):setTimeout(check,10);check()})`);
      const controls = await script(controlWindow, `(()=>({width:innerWidth,height:innerHeight,buttons:[...document.querySelectorAll('.controlBar button')].map(e=>{const r=e.getBoundingClientRect();return {disabled:e.disabled,x:r.x,y:r.y,right:r.right,bottom:r.bottom}})}))()`);
      assert.deepEqual([controls.width, controls.height], [440, 60]);
      assert.deepEqual(controls.buttons.map((button: { disabled: boolean }) => button.disabled), [state === 'encoding', state === 'encoding', false], `${state} 时暂停/停止/取消按钮状态必须正确`);
      for (let i = 0; i < controls.buttons.length; i++) {
        const button = controls.buttons[i];
        assert.ok(button.right > button.x && button.bottom > button.y && button.x >= 0 && button.y >= 0 && button.right <= 440 && button.bottom <= 60, `${state} 控制条按钮必须完整显示`);
        for (let j = i + 1; j < controls.buttons.length; j++) {
          const other = controls.buttons[j];
          assert.ok(Math.min(button.right, other.right) - Math.max(button.x, other.x) <= 1 || Math.min(button.bottom, other.bottom) - Math.max(button.y, other.y) <= 1, `${state} 控制条按钮不能相互遮挡`);
        }
      }
      if (state === 'recording') await saveScreenshot(controlWindow, 'recording-controls');
    }
    assert.equal(borderWindow.isDestroyed(), true, '编码阶段应关闭录制区域边框');
  } finally {
    recordingControls.dispose();
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0, '控制条回归结束应关闭所有隔离窗口');
  windows.dispose(); clearTimeout(deadline);
  console.log('PASS capture UI: text re-edit/font presets, shape/color editing, undo/redo, PNG, narrow-screen layout, recording controls, synthetic three-display magnifier');
  removeProfile(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
