/**
 * 站内链接弹窗登录态验收：临时 Electron profile、本地服务与模拟 HttpOnly ticket。
 * node scripts/acceptance/popup-login-session.cjs
 * --baseline <ref> 用指定提交的旧策略复现，不读取用户账号或调用真实后端。
 */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { createServer } = require('node:http');

const fixtureEnvironment = 'NUWAX_POPUP_LOGIN_FIXTURE';
const policyRelative = 'overlay/crates/agent-electron-client/src/main/services/system/webviewPolicy.ts';
const bundlePath = temp => path.join(temp, 'main/services/policy.cjs');

async function launch() {
  const root = path.resolve(__dirname, '../..');
  const fromShell = createRequire(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json'));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nuwax-popup-login-'));
  let child, watchdog;
  try {
    const services = path.join(root, 'overlay/crates/agent-electron-client/src/main/services');
    const baseServices = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/src/main/services');
    const stubs = new Map([
      ['electron-log', 'export default {info(){},warn(){},error(){},debug(){}};'],
      ['@shared/constants', 'export const APP_NAME_IDENTIFIER="nuwax", DEFAULT_SERVER_HOST="https://unused.example", WEBVIEW_POPUP_BASE_WIDTH=600, WEBVIEW_POPUP_BASE_HEIGHT=400, WEBVIEW_POPUP_MIN_WIDTH=640, WEBVIEW_POPUP_MIN_HEIGHT=480;'],
      ['@fixture/db', 'export const settings=new Map(); export const readSetting=key=>settings.get(key)??null;'],
      ['@fixture/hostActivity', 'export const attachHostActivityBusinessWindow=()=>{};'],
      ['@fixture/newTaskAvailability', 'export const isGuestNewTaskAvailable=()=>false;'],
      ['@fixture/commercialTicketSession', 'export const currentTicket=()=>"fixture-ticket";'],
      ['@fixture/i18n', 'export const t=key=>key;'],
    ]);
    await fs.mkdir(path.join(temp, 'main/preload'), { recursive: true });
    await fs.writeFile(path.join(temp, 'main/preload/webviewPerfBridge.js'),
      'require("electron").contextBridge.exposeInMainWorld("popupFixtureBridge", true);\n');
    const baselineIndex = process.argv.indexOf('--baseline');
    const baselineRef = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
    if (baselineIndex >= 0) assert(baselineRef && !/^[\-]|[\s:]/.test(baselineRef), 'baseline requires a Git ref');
    const baseline = baselineRef
      ? execFileSync('git', ['show', `${baselineRef}:${policyRelative}`], { cwd: root, encoding: 'utf8' }) : null;
    await fromShell('esbuild').build({
      stdin: {
        contents: `export * from ${JSON.stringify(path.join(services, 'system/webviewPolicy.ts'))}; export * from ${JSON.stringify(path.join(services, 'sessionAuthInjection.ts'))}; export { settings } from '@fixture/db';`,
        resolveDir: root,
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath(temp), external: ['electron'],
      plugins: [{ name: 'popup-login-fixture', setup(build) {
        build.onResolve({ filter: /^(electron-log|@shared\/constants|@fixture\/db)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        build.onResolve({ filter: /^(?:\.\.\/)+db$/ }, () => ({ path: '@fixture/db', namespace: 'fixture' }));
        for (const name of ['hostActivity', 'newTaskAvailability', 'commercialTicketSession', 'i18n']) {
          build.onResolve({ filter: new RegExp(`^(?:\\.\\./|\\./)${name}$`) }, () => ({ path: `@fixture/${name}`, namespace: 'fixture' }));
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
        if (baseline) build.onLoad({ filter: /system\/webviewPolicy\.ts$/ }, () => ({ contents: baseline, loader: 'ts', resolveDir: path.join(services, 'system') }));
      } }],
    });
    const env = { ...process.env, [fixtureEnvironment]: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(fromShell('electron'), [__filename], { env, stdio: 'inherit' });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 45_000);
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
  const { app, BrowserWindow, session } = require('electron');
  const temp = process.env[fixtureEnvironment];
  assert(temp);
  fsSync.mkdirSync(path.join(temp, 'profile'), { recursive: true });
  app.setPath('userData', path.join(temp, 'profile'));
  app.setPath('sessionData', path.join(temp, 'profile'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { initWebviewPolicy, initSessionAuthInjection, settings } = require(bundlePath(temp));
  const requests = [];
  let gatewayOrigin;
  const serve = role => createServer((req, res) => {
    const authenticated = /(?:^|;\s*)ticket=fixture-ticket(?:;|$)/.test(req.headers.cookie || '');
    const capability = req.headers['x-nuwax-gateway-request'] === 'fixture-gateway-secret';
    const url = new URL(req.url, 'http://fixture');
    requests.push({ role, path: url.pathname, search: url.search, authenticated, capability, referrer: req.headers.referer || '' });
    if (url.pathname === '/api/me') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authenticated, capability }));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Popup session fixture</title><h1>${authenticated ? 'LOGGED_IN' : 'LOGIN_REQUIRED'}</h1>`);
    }
  });
  const businessServer = serve('business'), gatewayServer = serve('gateway'), externalServer = serve('external');
  const servers = [businessServer, gatewayServer, externalServer];
  for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${businessServer.address().port}`;
  gatewayOrigin = `http://127.0.0.1:${gatewayServer.address().port}`;
  const externalOrigin = `http://127.0.0.1:${externalServer.address().port}`;
  let context = { businessOrigin: origin, trustedOrigins: [origin] };
  settings.set('step1_config', { serverHost: origin });
  initSessionAuthInjection(() => context);
  initWebviewPolicy(() => null);
  await session.defaultSession.cookies.set({ url: origin, name: 'ticket', value: 'fixture-ticket', httpOnly: true, path: '/', sameSite: 'lax' });
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const windows = BrowserWindow.getAllWindows().map(win => ({
      url: win.webContents.getURL(), loading: win.webContents.isLoading(), businessSession: win.webContents.session === session.defaultSession,
    }));
    assert.fail(`timed out: ${label}; windows=${JSON.stringify(windows)}; requests=${JSON.stringify(requests.slice(-6))}`);
  };
  const openFrom = async (contents, target, kind) => {
    const ids = new Set(BrowserWindow.getAllWindows().map(win => win.id));
    const code = kind === 'anchor'
      ? `(() => { const a=document.createElement('a'); a.href=${JSON.stringify(target)}; a.target='_blank'; a.rel='noopener noreferrer'; document.body.append(a); a.click(); a.remove(); })();`
      : `window.open(${JSON.stringify(target)}, '_blank', 'noopener,noreferrer'); void 0;`;
    await contents.executeJavaScript(code, true);
    return waitFor(() => BrowserWindow.getAllWindows().find(win => !ids.has(win.id) &&
      !win.webContents.isLoading() && win.webContents.getURL() === target), `loaded popup: ${kind}`);
  };
  try {
    for (const mode of ['direct', 'gateway']) {
      settings.set('nuwax.loopback', { enabled: mode === 'gateway', origin: gatewayOrigin });
      context = { businessOrigin: origin, trustedOrigins: mode === 'gateway' ? [origin, gatewayOrigin] : [origin],
        gateway: mode === 'gateway' ? { origin: gatewayOrigin, requestSecret: 'fixture-gateway-secret' } : null };
      const source = mode === 'gateway' ? gatewayOrigin : origin;
      for (const type of ['window', 'webview']) {
        const host = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, webviewTag: type === 'webview' } });
        let opener = host.webContents;
        if (type === 'webview') {
          const attached = new Promise(resolve => host.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)));
          const hostFile = path.join(temp, `host-${mode}.html`);
          await fs.writeFile(hostFile, `<webview allowpopups style="width:800px;height:600px" src="${source}/instant-message"></webview>`);
          await host.loadFile(hostFile);
          opener = await attached;
          await waitFor(() => !opener.isLoading() && opener.getURL() === `${source}/instant-message`, 'webview loaded');
        } else {
          await host.loadURL(`${source}/instant-message`);
        }
        const loggedIn = await opener.executeJavaScript("fetch('/api/me').then(r=>r.json())");
        assert(loggedIn.authenticated, `${mode}/${type}: main page has login state`);
        if (mode === 'gateway') assert(loggedIn.capability, 'gateway requests retain the frame capability');
        for (const kind of ['anchor', 'window.open']) {
          const route = kind === 'anchor' ? '/' : '/repo/doc/fixture';
          const target = `${origin}${route}?case=${mode}-${type}-${kind}`;
          const child = await openFrom(opener, target, kind);
          assert.equal(child.webContents.session, session.defaultSession, `${mode}/${type}/${kind}: shared business session`);
          const request = requests.find(entry => entry.role === 'business' && entry.search === new URL(target).search);
          assert(request && request.authenticated, `${mode}/${type}/${kind}: first document request has ticket`);
          assert.equal(request.referrer, '', 'noreferrer does not become a fabricated referrer');
          const page = await child.webContents.executeJavaScript("({text:document.body.innerText, noOpener:window.opener===null, bridge:window.popupFixtureBridge===true})");
          assert.equal(page.text.trim(), 'LOGGED_IN');
          assert(page.noOpener, 'noopener remains effective');
          assert(page.bridge, 'business popup retains the page bridge preload');
          const api = await child.webContents.executeJavaScript("fetch('/api/me').then(r=>r.json())");
          assert(api.authenticated, 'subsequent API request retains login');
          child.destroy();
          console.log(`PASS ${mode}/${type}/${kind}: first document and subsequent API logged in`);
        }
        const outside = await openFrom(opener, `${externalOrigin}/outside?case=${mode}-${type}`, 'anchor');
        assert.notEqual(outside.webContents.session, session.defaultSession, 'external popup stays isolated');
        assert.equal(await outside.webContents.executeJavaScript('window.popupFixtureBridge'), undefined);
        const request = requests.find(entry => entry.role === 'external' && entry.search === `?case=${mode}-${type}`);
        assert(request && !request.authenticated && !request.capability, 'external popup receives no ticket or gateway capability');
        outside.destroy();
        console.log(`PASS ${mode}/${type}: external link remains isolated`);
        host.destroy();
      }
    }
    console.log(`PASS popup login session acceptance; Electron=${process.versions.electron}`);
  } finally {
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    app.quit();
  }
}

(process.env[fixtureEnvironment] ? run() : launch()).catch(error => {
  console.error(error);
  process.exitCode = 1;
  if (process.env[fixtureEnvironment]) require('electron').app.exit(1);
});
