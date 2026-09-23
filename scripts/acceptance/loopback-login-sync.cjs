/**
 * Real Electron + local HTTP/WS acceptance; no user profile or real credentials.
 * Run from outer repo: node scripts/acceptance/loopback-login-sync.cjs
 * Uses installed Electron/esbuild from the pinned shell checkout. Tests source,
 * not a released installer or the production backend contract.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash, randomBytes } = require('node:crypto');

async function launch() {
  const root = path.resolve(__dirname, '../..');
  const fromShell = createRequire(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json'));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nuwax-loopback-fixture-'));
  const services = path.join(root, 'overlay/crates/agent-electron-client/src/main/services');
  const bundle = path.join(temp, 'implementation.cjs');
  await fromShell('esbuild').build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(path.join(services, 'sessionAuthInjection.ts'))};`,
        `export * from ${JSON.stringify(path.join(services, 'loopbackGateway/gateway.ts'))};`,
        `export * from ${JSON.stringify(path.join(services, 'loopbackGateway/routingPolicy.ts'))};`,
      ].join('\n'),
      resolveDir: root,
    },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    external: ['electron'],
    plugins: [{
      name: 'fixture-build-environment',
      setup(build) {
        build.onResolve({ filter: /^(electron-log|@shared\/constants)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path === 'electron-log'
            ? 'export default {info(){},warn(){},error(){},debug(){}};'
            : 'export const APP_NAME_IDENTIFIER = "nuwax";',
          loader: 'js',
        }));
      },
    }],
  });
  const env = { ...process.env, NUWAX_LOOPBACK_FIXTURE: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(fromShell('electron'), [__filename], { env, stdio: 'inherit' });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  clearTimeout(watchdog);
  console.log(`FIXTURE_ARTIFACTS ${temp}`);
  process.exitCode = code;
}

async function run() {
  const { app, BrowserWindow, session, net } = require('electron');
  const temp = process.env.NUWAX_LOOPBACK_FIXTURE;
  app.setPath('userData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('no-proxy-server');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { startLoopbackGateway, initSessionAuthInjection, trustInitialBusinessNavigation, normalizeGatewayRequestUrl } = require(path.join(temp, 'implementation.cjs'));
  const token = 'fixture-current-token';
  const requestSecret = randomBytes(24).toString('hex');
  const requests = [];
  const interceptions = [];
  const windows = [];
  const sockets = new Set();
  let gateway;
  let backendOrigin;
  const prefixes = ['/api', '/computer', '/devcomputer', '/repo', '/instant-message'];
  const backend = createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    }
    if (req.method === 'OPTIONS') { res.end(); return; }
    const pathname = new URL(req.url, backendOrigin).pathname;
    if (pathname === '/repo/page') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><body><script>
        window.fixturePromise = Promise.all([
          fetch('/files/root').then(r=>r.text()),
          fetch('relative').then(r=>r.text()),
          fetch(${JSON.stringify(backendOrigin + '/files/absolute')}).then(r=>r.text()),
          fetch(${JSON.stringify(backendOrigin + '/api/absolute-auth')},{headers:{Authorization:'Bearer fixture-current-token'},credentials:'include'}).then(r=>r.json()).then(j=>j.authorization),
          fetch('/files/redirect').then(r=>r.text()),
          fetch('/internal/post',{method:'POST',body:'fixture-body'}).then(r=>r.text()),
          import('/modules/entry.js').then(m=>m.value)
        ]);
      </script><link rel="stylesheet" href="/styles/app.css"><img src="/files/image.svg"></body></html>`);
    } else if (pathname === '/internal/post') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => res.end(`${req.method}:${body}`));
    } else if (pathname === '/files/redirect') {
      res.writeHead(302, { Location: '/files/redirect-result?from=redirect' }).end();
    } else if (pathname === '/modules/entry.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('import {value} from "/modules/value.js"; export {value};');
    } else if (pathname === '/modules/value.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('export const value="module-upstream";');
    } else if (pathname === '/styles/app.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end('body {background-image:url(/files/css-image.svg)}');
    } else if (pathname.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    } else if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }));
    } else if (pathname === '/home/direct') {
      res.setHeader('Content-Type', 'text/html'); res.end('<html><body>Direct fixture</body></html>');
    } else {
      res.setHeader('Content-Type', 'text/plain'); res.end(`upstream:${req.url}`);
    }
  });
  backend.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    requests.push({ url: req.url, method: 'WS', authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => socket.end(Buffer.from([0x88, 0x00])));
  });
  const foreign = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>Untrusted fixture</body></html>'); });
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const newWindow = () => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.log('BROWSER', event.message);
    });
    windows.push(win); return win;
  };
  const last = (url) => requests.filter((entry) => entry.url === url && entry.method !== 'OPTIONS').at(-1);
  const checkBearer = (url) => { const request = last(url); assert(request, `request missing: ${url}`); assert.equal(request.authorization, `Bearer ${token}`, url); assert(!/(^|;\s*)ticket=/.test(request.cookie ?? ''), url); };
  try {
    backendOrigin = await listen(backend);
    const foreignOrigin = await listen(foreign);
    const dist = path.join(temp, 'dist');
    await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<html><body>Main fixture</body></html>');
    await fs.writeFile(path.join(dist, 'assets/local.txt'), 'local-dist');
    gateway = await startLoopbackGateway({ targetOrigin: backendOrigin, distDir: dist, backendPrefixes: prefixes, fixedPort: 0, getAccessToken: () => token, clientTypeHeader: 'nuwax', trustedRequestSecret: requestSecret });
    initSessionAuthInjection(() => ({ businessOrigin: backendOrigin, trustedOrigins: [backendOrigin, gateway.origin], accessToken: token, gateway: { origin: gateway.origin, requestSecret } }));
    await session.defaultSession.cookies.set({ url: backendOrigin, name: 'ticket', value: 'fixture-old-ticket', path: '/' });
    await session.defaultSession.cookies.set({ url: backendOrigin, name: 'preference', value: 'kept', path: '/' });

    const direct = newWindow();
    trustInitialBusinessNavigation(direct.webContents, backendOrigin + '/home/direct');
    await direct.loadURL(backendOrigin + '/home/direct');
    checkBearer('/home/direct');
    const auto = await direct.webContents.executeJavaScript('fetch("/api/auto").then(r=>r.json())');
    assert.equal(auto.authorization, `Bearer ${token}`); assert.equal(auto.cookie, 'preference=kept');
    const explicit = await direct.webContents.executeJavaScript('fetch("/api/explicit",{headers:{Authorization:"Bearer page-token"}}).then(r=>r.json())');
    assert.equal(explicit.authorization, 'Bearer page-token'); assert.equal(explicit.cookie, 'preference=kept');
    const login = await direct.webContents.executeJavaScript('fetch("/api/user/passwordLogin",{method:"POST"}).then(r=>r.json())');
    assert.equal(login.authorization, null); assert.equal(login.cookie, 'preference=kept');
    const registration = await net.fetch(backendOrigin + '/api/sandbox/config/reg', { credentials: 'omit', headers: { Authorization: `Bearer ${token}`, Cookie: `ticket=${token}` } }).then((r) => r.json());
    assert.equal(registration.authorization, `Bearer ${token}`); assert.equal(registration.cookie, `ticket=${token}`);
    const withoutTicket = await net.fetch(backendOrigin + '/api/sandbox/config/reg', { credentials: 'omit', headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    assert.equal(withoutTicket.authorization, `Bearer ${token}`); assert.equal(withoutTicket.cookie, null);

    const wsTest = (win, url) => win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const w=new WebSocket(${JSON.stringify(url)});const timer=setTimeout(()=>{w.close();reject(new Error('WS timeout'));},5000);w.onopen=()=>{clearTimeout(timer);w.close();resolve(true)};w.onerror=()=>{clearTimeout(timer);reject(new Error('WS failed'))}})`);
    await wsTest(direct, backendOrigin.replace('http:', 'ws:') + '/computer/ws-direct'); checkBearer('/computer/ws-direct');
    const external = newWindow(); await external.loadURL(foreignOrigin);
    await external.webContents.executeJavaScript(`fetch(${JSON.stringify(backendOrigin + '/api/untrusted')},{credentials:'include'}).then(r=>r.json())`);
    assert.equal(last('/api/untrusted').authorization, null); assert.equal(last('/api/untrusted').cookie, 'preference=kept');
    console.log('PASS Electron direct headers, public login, main-process registration, WS and untrusted origin');

    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const redirectURL = normalizeGatewayRequestUrl({ url: details.url, resourceType: details.resourceType, webContentsUrl: details.webContents?.getURL() ?? '', frameUrl: details.frame?.url, parentFrameUrl: details.frame?.parent?.url, referrer: details.referrer }, { gatewayOrigin: gateway.origin, backendOrigin, backendPrefixes: prefixes });
      interceptions.push({ url: details.url, type: details.resourceType, top: details.webContents?.getURL(), frame: details.frame?.url, parent: details.frame?.parent?.url, referrer: details.referrer, redirectURL });
      callback(redirectURL ? { redirectURL } : {});
    });
    session.defaultSession.webRequest.onSendHeaders((details) => {
      interceptions.push({ sent: details.url, headers: details.requestHeaders });
    });
    const main = newWindow(); await main.loadURL(gateway.origin + '/home/app');
    assert.equal(await main.webContents.executeJavaScript('fetch("/assets/local.txt").then(r=>r.text())'), 'local-dist');
    const proxied = await main.webContents.executeJavaScript('fetch("/api/proxied").then(r=>r.json())');
    assert.equal(proxied.authorization, `Bearer ${token}`); assert.equal(proxied.cookie, 'preference=kept');
    await external.webContents.executeJavaScript(`fetch(${JSON.stringify(gateway.origin + '/api/untrusted-gateway')},{mode:'no-cors'}).then(()=>true)`);
    assert.equal(last('/api/untrusted-gateway').authorization, null);
    await wsTest(external, gateway.origin.replace('http:', 'ws:') + '/computer/ws-untrusted');
    assert.equal(last('/computer/ws-untrusted').authorization, null);
    await wsTest(main, gateway.origin.replace('http:', 'ws:') + '/computer/ws-gateway'); checkBearer('/computer/ws-gateway');
    await wsTest(main, backendOrigin.replace('http:', 'ws:') + '/socket/absolute-ws'); checkBearer('/socket/absolute-ws');
    const documentUrl = await main.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const f=document.createElement('iframe');f.onload=()=>{try{resolve(f.contentWindow.location.href)}catch(e){reject(e)}};f.onerror=reject;f.src=${JSON.stringify(backendOrigin + '/repo/absolute-document')};document.body.appendChild(f)})`);
    assert.equal(documentUrl, gateway.origin + '/repo/absolute-document');
    const resources = await main.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const f=document.createElement('iframe');f.onload=()=>{Promise.resolve(f.contentWindow.fixturePromise).then(resolve,reject)};f.onerror=reject;f.src='/repo/page';document.body.appendChild(f)})`);
    assert.deepEqual(resources, ['upstream:/files/root', 'upstream:/repo/relative', 'upstream:/files/absolute', `Bearer ${token}`, 'upstream:/files/redirect-result?from=redirect', 'POST:fixture-body', 'module-upstream']);
    for (const url of ['/repo/page', '/files/root', '/repo/relative', '/files/absolute', '/files/redirect-result?from=redirect', '/internal/post', '/modules/value.js', '/styles/app.css', '/files/image.svg']) checkBearer(url);
    // CSS images may be requested on the next compositor update.
    for (let i = 0; i < 50 && !last('/files/css-image.svg'); i++) await new Promise((r) => setTimeout(r, 20));
    checkBearer('/files/css-image.svg');
    assert(!requests.some((r) => r.url.startsWith('/__backend/')));
    console.log('PASS Electron gateway HTTP/WS, iframe absolute/root/relative resources, CSS/module dependencies and resource redirect');
    await fs.writeFile(path.join(temp, 'requests.json'), JSON.stringify({ electron: process.versions.electron, requests }, null, 2));
    console.log(`PASS LOOPBACK_LOGIN_SYNC electron=${process.versions.electron} requests=${requests.length}`);
  } finally {
    await fs.writeFile(path.join(temp, 'requests.json'), JSON.stringify({ electron: process.versions.electron, requests, interceptions }, null, 2));
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    for (const socket of sockets) socket.destroy();
    if (gateway) await gateway.close();
    for (const server of [backend, foreign]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    app.quit();
  }
}

if (process.versions.electron && process.env.NUWAX_LOOPBACK_FIXTURE) {
  run().catch((error) => { console.error(error); require('electron').app.exit(1); });
} else {
  launch().catch((error) => { console.error(error); process.exitCode = 1; });
}
