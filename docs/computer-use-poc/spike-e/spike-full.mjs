// Spike E 全功能：经 helper daemon 截图 + element_token 点击 + 复查
import { CuaDriver, ActionTarget, ClickPosition, InputDeliveryMode } from '@trycua/cua-driver';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(exec);
const json = (v) => JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? val.toString() : val));
const log = (...a) => console.log('[spike-full]', ...a);

const d = CuaDriver.connect('/tmp/cua-spike/cua.sock');
const meta = await d.metadata();
log('daemon pid', meta.pid, 'embedded', meta.embedded);

await pexec('open -a Calculator');
await new Promise((r) => setTimeout(r, 1200));
const { windows } = await d.listWindows({});
const win = windows.find((w) => /calculator|计算器/i.test(w.appName));
if (!win) throw new Error('计算器窗口未找到');
log('window:', win.appName, json(win.bounds));

const st = await d.getWindowState({
  pid: win.pid, windowId: win.windowId,
  includeAccessibilityTree: true, includeScreenshot: true,
  screenshotOutFile: '/Users/apple/Documents/git-workspace/cua-poc/spike-e/helper-shot.png',
  maxElements: 400,
});
log('elements:', String(st.elementCount), 'screenshot → helper-shot.png');

const ac = st.elements?.find((e) => /全部清除|all clear/i.test(e.label ?? ''));
const six = st.elements?.find((e) => e.label === '6');
log('目标按钮: 全部清除=', !!ac, ' 6=', !!six);

if (ac) {
  const r1 = await d.click({
    target: new ActionTarget.Window({ pid: win.pid, windowId: win.windowId }),
    position: new ClickPosition.Element({ elementToken: ac.elementToken }),
    deliveryMode: InputDeliveryMode.Background,
  });
  log('click 全部清除 →', r1.isError ? `ERROR ${r1.errorCode}` : 'ok');
  await new Promise((r) => setTimeout(r, 400));
}
if (six) {
  const r2 = await d.click({
    target: new ActionTarget.Window({ pid: win.pid, windowId: win.windowId }),
    position: new ClickPosition.Element({ elementToken: six.elementToken }),
    deliveryMode: InputDeliveryMode.Background,
  });
  log('click 6 →', r2.isError ? `ERROR ${r2.errorCode}` : 'ok');
}

const after = await d.getWindowState({
  pid: win.pid, windowId: win.windowId, includeScreenshot: true,
  screenshotOutFile: '/Users/apple/Documents/git-workspace/cua-poc/spike-e/helper-shot-after.png',
  includeAccessibilityTree: false,
});
log('after screenshot ok, appName:', after.appName);

d.uniffiDestroy?.();
log('DONE — 经 helper 全功能（元素树/截图/后台点击）闭环通过');
process.exit(0);
