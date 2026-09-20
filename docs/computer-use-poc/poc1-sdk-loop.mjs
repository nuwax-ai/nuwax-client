// PoC 1: cua-driver 进程内 SDK 闭环探测
// 用法: node poc1-sdk-loop.mjs probe | act
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import {
  CuaDriver,
  DriverOptions,
  ActionTarget,
  ClickPosition,
  InputDeliveryMode,
  currentMacOsPermissionStatus,
} from '@trycua/cua-driver';

const pexec = promisify(exec);
const OUT = new URL('.', import.meta.url).pathname;
const json = (v) => JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? val.toString() : val), 2);
const log = (...a) => console.log('[poc1]', ...a);

async function findCalculatorWindow(driver) {
  const { windows } = await driver.listWindows({});
  const win = windows.find((w) => /calculator|计算器/i.test(w.appName) || /calculator|计算器/i.test(w.title));
  return { windows, win };
}

async function main() {
  const mode = process.argv[2] ?? 'probe';

  // 1) TCC 权限状态（探测进程 = 本 node 进程，经宿主责任链）
  const perm = currentMacOsPermissionStatus();
  log('macOS TCC status:', JSON.stringify(perm));

  // 2) 进程内运行时
  const driver = CuaDriver.create(DriverOptions.create({ claudeCodeCompatibility: false }));
  const meta = await driver.metadata();
  log('driver metadata:', json(meta));

  // 3) 确保计算器在跑
  await pexec('open -a Calculator');
  await new Promise((r) => setTimeout(r, 1500));
  const apps = await driver.listApps({});
  const calc = apps.apps.find((a) => /calculator|计算器/i.test(a.name));
  log('calculator app:', json(calc));

  const { win } = await findCalculatorWindow(driver);
  if (!win) throw new Error('Calculator window not found');
  log('calculator window:', json(win));

  // 4) 窗口状态：元素树 + 截图落盘
  const state = await driver.getWindowState({
    pid: win.pid,
    windowId: win.windowId,
    includeAccessibilityTree: true,
    includeScreenshot: true,
    screenshotOutFile: OUT + 'shot-before.png',
    maxElements: 400,
    maxDepth: 12,
  });
  fs.writeFileSync(OUT + 'calc-window-state.json', json(state));
  fs.writeFileSync(OUT + 'calc-tree.md', state.treeMarkdown ?? '');
  log('elements:', String(state.elementCount), '/', String(state.totalElementCount));

  // 5) 打印可交互元素摘要（role/label/value/token 前缀）
  for (const el of state.elements ?? []) {
    const interactive = (el.actions?.length ?? 0) > 0 || /button/i.test(el.role);
    if (interactive) {
      log(
        `  [${el.elementIndex}] role=${el.role} label=${JSON.stringify(el.label ?? '')} value=${JSON.stringify(el.value ?? '')} token=${(el.elementToken ?? '').slice(0, 12)}… frame=${JSON.stringify(el.frame)}`,
      );
    }
  }

  if (mode === 'probe') {
    await driver.shutdown();
    driver.uniffiDestroy?.();
    log('probe done → shot-before.png / calc-window-state.json / calc-tree.md');
    return;
  }

  // ---- act 模式：点击 6 × 7 = 并读显示屏 ----
  const labelMap = {
    six: '6', '6': '6',
    seven: '7', '7': '7',
    multiply: '*', '×': '*', 'x': '*', '*': '*', '乘': '*',
    equals: '=', '=': '=', '=': '=', '等于': '=',
  };
  const displayMap = { allclear: 'AC', ac: 'AC', c: 'C' };
  const norm = (s) => (s ?? '').trim().toLowerCase();
  const els = state.elements ?? [];
  const byToken = new Map(els.map((e) => [e.elementToken, e]));
  const findBtn = (want) => {
    const target = labelMap[norm(want)];
    return els.find(
      (e) => /button/i.test(e.role) && labelMap[norm(e.label)] === target && !/clear|ac/i.test(norm(e.label)),
    );
  };
  const clickEl = async (el, name) => {
    const res = await driver.click({
      target: new ActionTarget.Window({ pid: win.pid, windowId: win.windowId }),
      position: new ClickPosition.Element({ elementToken: el.elementToken }),
      deliveryMode: InputDeliveryMode.Background,
    });
    log(`click ${name} →`, json(res).slice(0, 200));
    await new Promise((r) => setTimeout(r, 350));
  };

  for (const k of ['6', '×', '7', '=']) {
    const el = findBtn(k);
    if (!el) throw new Error(`button not found for ${k}`);
    await clickEl(el, `${k}(${el.label})`);
  }

  // 6) 复查：读显示屏元素
  const after = await driver.getWindowState({
    pid: win.pid,
    windowId: win.windowId,
    includeAccessibilityTree: true,
    includeScreenshot: true,
    screenshotOutFile: OUT + 'shot-after.png',
    maxElements: 400,
  });
  const texts = (after.elements ?? []).filter((e) => /text/i.test(e.role) && (e.value ?? e.label ?? '') !== '');
  log('text elements after:', json(texts.map((e) => ({ role: e.role, label: e.label, value: e.value }))));
  fs.writeFileSync(OUT + 'calc-after-state.json', json(after));

  await driver.shutdown();
  driver.uniffiDestroy?.();
  log('act done → shot-after.png / calc-after-state.json');
}

main().catch((e) => {
  console.error('[poc1] FAILED:', e?.message ?? e);
  if (e?.tag) console.error('  error tag:', e.tag, json(e.inner ?? {}));
  process.exit(1);
});
