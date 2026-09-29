/**
 * 待支付收银台关闭验收：临时 profile、模拟订单，不调用真实支付接口。
 * node scripts/acceptance/payment-window.cjs
 * 加 --interactive 可手动点原生红色按钮，验证“留在此页”和“离开”。
 */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');

const fixtureEnvironment = 'NUWAX_PAYMENT_WINDOW_FIXTURE';
const bundlePath = temp => path.join(temp, 'main/services/policy.cjs');

async function launch() {
  const root = path.resolve(__dirname, '../..');
  const fromShell = createRequire(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json'));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nuwax-payment-window-'));
  let child;
  let watchdog;
  try {
    const services = path.join(root, 'overlay/crates/agent-electron-client/src/main/services');
    const baseServices = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/src/main/services');
    const locale = JSON.parse(await fs.readFile(path.join(root, 'overlay/crates/agent-electron-client/src/shared/locales/zh-CN.json'), 'utf8'));
    const stubs = new Map([
      ['electron-log', 'export default {info(){},warn(){},error(){},debug(){}};'],
      ['@shared/constants', 'export const APP_NAME_IDENTIFIER="nuwax", DEFAULT_SERVER_HOST="https://unused.example", WEBVIEW_POPUP_BASE_WIDTH=600, WEBVIEW_POPUP_BASE_HEIGHT=400, WEBVIEW_POPUP_MIN_WIDTH=640, WEBVIEW_POPUP_MIN_HEIGHT=480;'],
      ['@fixture/db', 'export const settings=new Map(); export const readSetting=key=>settings.get(key)??null;'],
      ['@fixture/hostActivity', 'export const attachHostActivityBusinessWindow=()=>{};'],
      ['@fixture/newTaskAvailability', 'export const isGuestNewTaskAvailable=()=>false;'],
      ['@fixture/sessionAuthInjection', 'export const trustInitialBusinessNavigation=()=>{};'],
      ['@fixture/i18n', `const locale=${JSON.stringify(locale)}; export const t=key=>locale[key]??key;`],
    ]);
    await fs.mkdir(path.join(temp, 'main/preload'), { recursive: true });
    await fs.writeFile(path.join(temp, 'main/preload/webviewPerfBridge.js'), '// No IPC or credentials in this fixture.\n');
    await fromShell('esbuild').build({
      stdin: {
        contents: `export * from ${JSON.stringify(path.join(services, 'system/webviewPolicy.ts'))}; export { settings } from '@fixture/db';`,
        resolveDir: root,
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath(temp), external: ['electron'],
      plugins: [{
        name: 'payment-window-fixture',
        setup(build) {
          build.onResolve({ filter: /^(electron-log|@shared\/constants|@fixture\/db)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
          build.onResolve({ filter: /^(?:\.\.\/)+db$/ }, () => ({ path: '@fixture/db', namespace: 'fixture' }));
          for (const name of ['hostActivity', 'newTaskAvailability', 'sessionAuthInjection', 'i18n']) {
            build.onResolve({ filter: new RegExp(`^\\.\\./${name}$`) }, () => ({ path: `@fixture/${name}`, namespace: 'fixture' }));
          }
          build.onResolve({ filter: /^\.{1,2}\// }, args => {
            if (!args.resolveDir.startsWith(services + path.sep)) return;
            const candidate = path.resolve(args.resolveDir, args.path);
            if (['', '.ts', '.js', '/index.ts'].some(suffix => fsSync.existsSync(candidate + suffix))) return;
            const base = path.join(baseServices, path.relative(services, candidate));
            const found = ['', '.ts', '.js', '/index.ts'].map(suffix => base + suffix).find(file => fsSync.existsSync(file));
            if (found) return { path: found };
          });
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs.get(args.path), loader: 'js' }));
        },
      }],
    });
    const env = { ...process.env, [fixtureEnvironment]: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(fromShell('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
    watchdog = setTimeout(() => child.kill('SIGKILL'), process.argv.includes('--interactive') ? 240_000 : 45_000);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function run() {
  const { app, BrowserWindow, dialog } = require('electron');
  const temp = process.env[fixtureEnvironment];
  assert(temp);
  fsSync.mkdirSync(path.join(temp, 'profile'), { recursive: true });
  app.setPath('userData', path.join(temp, 'profile'));
  app.setPath('sessionData', path.join(temp, 'profile'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { initWebviewPolicy, settings } = require(bundlePath(temp));
  const cashierHtml = `<!doctype html><html><head><title>待支付收银台关闭验收</title></head><body>
    <h1>模拟待支付收银台</h1><p>本页面不创建订单或收款。</p><button id="pending">继续支付</button>
    <script>window.addEventListener('beforeunload', function(event) {
      event.preventDefault(); event.returnValue='还未完成支付，是否要离开？'; return event.returnValue;
    });</script></body></html>`;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url.startsWith('/cashier') ? cashierHtml : '<html><head><title>主业务页验收</title></head><body>主业务页</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const externalOrigin = `http://localhost:${server.address().port}`;
  settings.set('step1_config', { serverHost: origin });
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`timed out: ${label}`);
  };
  let main;
  let choice = 1;
  const prompts = [];
  const originalDialog = dialog.showMessageBoxSync;
  try {
    // 先复现：没有主进程确认处理时，红色关闭按钮对应的 close 被页面拦截。
    const blocked = new BrowserWindow({ show: false });
    await blocked.loadURL(`${externalOrigin}/cashier`);
    let prevented = false;
    blocked.webContents.once('will-prevent-unload', () => { prevented = true; });
    blocked.close();
    await waitFor(() => prevented, 'beforeunload reproduced');
    assert(!blocked.isDestroyed(), 'unhandled pending payment blocks native close');
    blocked.destroy();
    console.log('PASS reproduced pending-payment close blocked before policy');

    initWebviewPolicy(() => main ?? null);
    main = new BrowserWindow({ show: false, frame: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await main.loadURL(`${origin}/`);
    if (process.argv.includes('--interactive')) {
      const child = new BrowserWindow({ width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
      await child.loadURL(`${externalOrigin}/cashier`);
      console.log('READY native close confirmation: choose Stay once, then Leave');
      await new Promise(resolve => child.once('closed', resolve));
      assert(!main.isDestroyed(), 'closing cashier keeps main window');
      console.log('PASS interactive native close keeps main window');
      return;
    }
    dialog.showMessageBoxSync = (win, options) => { prompts.push({ win, options }); return choice; };
    for (const mode of ['standalone', 'anchor', 'window.open', 'noreferrer', 'same-window']) {
      const ids = new Set(BrowserWindow.getAllWindows().map(win => win.id));
      let child;
      if (mode === 'standalone') {
        child = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
        await child.loadURL(`${externalOrigin}/cashier`);
      } else {
        const url = `${externalOrigin}/cashier?mode=${mode}`;
        const code = mode === 'window.open' || mode === 'noreferrer'
          ? `window.open(${JSON.stringify(url)}, '_blank', ${JSON.stringify(mode === 'noreferrer' ? 'noopener,noreferrer,frame=no' : 'frame=no')}); void 0;`
          : `(() => { const link=document.createElement('a'); link.href=${JSON.stringify(url)}; link.target=${JSON.stringify(mode === 'same-window' ? '_self' : '_blank')}; document.body.append(link); link.click(); link.remove(); })();`;
        await main.webContents.executeJavaScript(code, true);
        await waitFor(() => {
          child = BrowserWindow.getAllWindows().find(win => !ids.has(win.id) &&
            !win.webContents.isLoading() && win.webContents.getURL().includes('/cashier'));
          return !!child;
        }, `${mode}: cashier loaded`);
      }
      const start = prompts.length;
      choice = 1;
      child.close();
      await waitFor(() => prompts.length === start + 1, `${mode}: stay prompt`);
      assert(!child.isDestroyed(), `${mode}: stay preserves pending cashier`);
      assert.equal(prompts.at(-1).win, child, 'confirmation belongs to the cashier');
      assert.equal(prompts.at(-1).options.cancelId, 1, 'Escape cancels leaving');
      choice = 0;
      child.close();
      await waitFor(() => child.isDestroyed(), `${mode}: leave closes cashier`);
      assert.equal(prompts.length, start + 2, 'one confirmation per close attempt');
      assert(!main.isDestroyed(), `${mode}: main window preserved`);
      assert.equal(main.webContents.getURL(), `${origin}/`, 'main business URL preserved');
      console.log(`PASS ${mode}: stay keeps pending cashier; leave closes cashier; main survives`);
      // 部分旧壳策略会为 Chromium guest 的跨域首导航再建隔离窗口。
      // 验收选中已加载收银台的窗口，并清理本轮可能产生的临时 guest。
      for (const win of BrowserWindow.getAllWindows()) if (!ids.has(win.id)) win.destroy();
    }
    const ordinary = new BrowserWindow({ show: false });
    await ordinary.loadURL(`${externalOrigin}/`);
    const start = prompts.length;
    ordinary.close();
    await waitFor(() => ordinary.isDestroyed(), 'ordinary page closes directly');
    assert.equal(prompts.length, start, 'ordinary page needs no confirmation');
    console.log(`PASS ordinary page closes directly; Electron=${process.versions.electron}`);
  } finally {
    dialog.showMessageBoxSync = originalDialog;
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await new Promise(resolve => server.close(resolve));
    app.quit();
  }
}

(process.env[fixtureEnvironment] ? run() : launch()).catch(error => {
  console.error(error);
  process.exit(1);
});
