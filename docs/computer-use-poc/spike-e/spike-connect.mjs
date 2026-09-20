// Spike E: 主进程（node）连「open 拉起的独立 helper daemon」
import { CuaDriver } from '@trycua/cua-driver';

const json = (v) => JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? val.toString() : val));
const log = (...a) => console.log('[spike]', ...a);

const d = CuaDriver.connect('/tmp/cua-spike/cua.sock');
const meta = await d.metadata();
log('metadata:', json(meta));
log('→ embedded =', meta.embedded, '（false=独立 daemon 身份，正是 E 形态）');

// 权限归属验证：本 node 进程链（ZCode 宿主）已有 AX+SR 授权；
// 若 helper 报缺权限 → 证明 TCC 归属已隔离到 helper bundle（不继承宿主链）
let permText = '';
try {
  const perm = await d.callTool('check_permissions', '{}');
  permText = (perm.text ?? '').slice(0, 400);
  log('check_permissions:', permText, perm.isError ? `(isError code=${perm.errorCode})` : '');
} catch (e) {
  permText = `${e?.inner?.errorCode ?? ''} ${e?.inner?.message ?? e?.message ?? ''}`.slice(0, 300);
  log('check_permissions 被权限门拦截:', e?.tag, permText);
}

try {
  const apps = await d.listApps({});
  log('listApps ok, count =', apps.apps.length);
} catch (e) {
  log('listApps 失败:', e?.tag ?? '', e?.message?.slice(0, 200));
}

try {
  const st = await d.callTool('get_screen_size', '{}');
  log('get_screen_size:', (st.text ?? '').slice(0, 120), st.isError ? `isError=${st.errorCode}` : 'ok');
} catch (e) {
  log('get_screen_size 异常:', e?.message?.slice(0, 200));
}

d.uniffiDestroy?.();
log('done');
process.exit(0);
