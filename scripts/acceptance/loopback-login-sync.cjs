/**
 * Real Electron + local HTTP/WS acceptance for the cookie ticket contract;
 * no user profile or real credentials.
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
        `export * from ${JSON.stringify(path.join(services, 'commercialTicketSession.ts'))};`,
        `export * from ${JSON.stringify(path.join(services, 'nativeTicketCapability.ts'))};`,
        "export { fixtureSettings } from '@fixture/db';",
      ].join('\n'),
      resolveDir: root,
    },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    external: ['electron'],
    plugins: [{
      name: 'fixture-build-environment',
      setup(build) {
        build.onResolve({ filter: /^(electron-log|@shared\/constants|@fixture\/db)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
        build.onResolve({ filter: /^\.\.\/db$/ }, () => ({ path: '@fixture/db', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path === 'electron-log'
            ? 'export default {info(){},warn(){},error(){},debug(){}};'
            : args.path === '@fixture/db'
              ? 'export const fixtureSettings = new Map(); export const readSetting = (key) => fixtureSettings.get(key) ?? null; export const writeSetting = (key, value) => fixtureSettings.set(key, value);'
              : 'export const APP_NAME_IDENTIFIER = "nuwax"; export const DEFAULT_SERVER_HOST = "https://unused.example";',
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
  const dns = require('node:dns');
  const businessHost = 'fixture.business.test';
  const originalLookup = dns.lookup;
  dns.lookup = (hostname, options, callback) => {
    if (hostname !== businessHost) return originalLookup(hostname, options, callback);
    if (typeof options === 'function') return options(null, '127.0.0.1', 4);
    if (options?.all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return callback(null, '127.0.0.1', 4);
  };
  const temp = process.env.NUWAX_LOOPBACK_FIXTURE;
  app.setPath('userData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('host-resolver-rules', `MAP ${businessHost} 127.0.0.1`);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const {
    startLoopbackGateway, initSessionAuthInjection, trustInitialBusinessNavigation,
    normalizeGatewayRequestUrl, fixtureSettings, currentTicket, ticketEpoch,
    mirrorGatewaySetCookies, restoreTicketSession, setLoopbackTicketOrigin,
    nativeTicketHeaders,
  } = require(path.join(temp, 'implementation.cjs'));
  const firstTicket = 'fixture-first-ticket';
  const rotatedTicket = 'fixture-rotated-ticket';
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
    if (pathname === '/api/user/passwordLogin') {
      res.setHeader('Set-Cookie', `ticket=${firstTicket}; Path=/; HttpOnly; SameSite=Lax`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }));
    } else if (pathname === '/api/rotate') {
      res.setHeader('Set-Cookie', `ticket=${rotatedTicket}; Path=/; HttpOnly; SameSite=Lax`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }));
    } else if (pathname === '/api/logout') {
      res.setHeader('Set-Cookie', 'ticket=; Max-Age=0; Path=/; HttpOnly');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }));
    } else if (pathname === '/repo/page') {
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
  const listen = (server, host = '127.0.0.1') => new Promise((resolve) => server.listen(0, host, () => resolve(`http://${host}:${server.address().port}`)));
  const newWindow = () => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.log('BROWSER', event.message);
    });
    windows.push(win); return win;
  };
  const last = (url) => requests.filter((entry) => entry.url === url && entry.method !== 'OPTIONS').at(-1);
  const cookieValue = (cookie, name) => cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const checkTicket = (url, expected = firstTicket) => {
    const request = last(url);
    assert(request, `request missing: ${url}`);
    assert.equal(request.authorization, null, `${url}: legacy Authorization must be removed`);
    assert.equal(cookieValue(request.cookie, 'ticket'), expected, url);
  };
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  try {
    // Cookies are host scoped. Give the local backend a non-loopback business
    // hostname so the production localhost ticket-leak guard stays active.
    const localBackend = await listen(backend);
    backendOrigin = `http://${businessHost}:${new URL(localBackend).port}`;
    const foreignOrigin = await listen(foreign);
    const dist = path.join(temp, 'dist');
    await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<html><body>Main fixture</body></html>');
    await fs.writeFile(path.join(dist, 'assets/local.txt'), 'local-dist');
    fixtureSettings.set('step1_config', { serverHost: backendOrigin });
    gateway = await startLoopbackGateway({
      targetOrigin: backendOrigin, distDir: dist, backendPrefixes: prefixes,
      fixedPort: 0, getTicket: currentTicket, ticketEpoch,
      onSetCookie: (headers, epoch) => void mirrorGatewaySetCookies(headers, backendOrigin, epoch),
      clientTypeHeader: 'nuwax', trustedRequestSecret: requestSecret,
    });
    initSessionAuthInjection(() => ({ businessOrigin: backendOrigin, trustedOrigins: [backendOrigin, gateway.origin], gateway: { origin: gateway.origin, requestSecret } }));
    session.defaultSession.webRequest.onSendHeaders((details) => {
      interceptions.push({ sent: details.url, type: details.resourceType, id: details.webContentsId, top: details.webContents?.getURL(), frame: details.frame?.url, headers: details.requestHeaders });
    });
    await setLoopbackTicketOrigin(gateway.origin);
    await restoreTicketSession(gateway.origin);
    await session.defaultSession.cookies.set({ url: backendOrigin, name: 'preference', value: 'kept', path: '/' });

    const direct = newWindow();
    trustInitialBusinessNavigation(direct.webContents, backendOrigin + '/home/direct');
    await direct.loadURL(backendOrigin + '/home/direct');
    assert.equal(last('/home/direct').authorization, null);
    assert.equal(cookieValue(last('/home/direct').cookie, 'ticket'), null);
    const login = await direct.webContents.executeJavaScript('fetch("/api/user/passwordLogin",{method:"POST"}).then(r=>r.json())');
    assert.equal(login.authorization, null);
    assert.equal(cookieValue(login.cookie, 'ticket'), null, 'public login must not inherit a prior session');
    await waitFor(async () => currentTicket() === firstTicket &&
      (await session.defaultSession.cookies.get({ url: gateway.origin, name: 'ticket' }))[0]?.value === firstTicket,
    'direct login ticket to mirror into the gateway jar');
    const auto = await direct.webContents.executeJavaScript('fetch("/api/auto").then(r=>r.json())');
    assert.equal(auto.authorization, null); assert.equal(cookieValue(auto.cookie, 'ticket'), firstTicket);
    assert.equal(cookieValue(auto.cookie, 'preference'), 'kept');
    const explicit = await direct.webContents.executeJavaScript('fetch("/api/explicit",{headers:{Authorization:"Bearer page-token"}}).then(r=>r.json())');
    assert.equal(explicit.authorization, null); assert.equal(cookieValue(explicit.cookie, 'ticket'), firstTicket);
    const registration = await net.fetch(backendOrigin + '/api/sandbox/config/reg', { credentials: 'omit', headers: nativeTicketHeaders(firstTicket) }).then((r) => r.json());
    assert.equal(registration.authorization, null); assert.equal(registration.cookie, `ticket=${firstTicket}`);
    const withoutCapability = await net.fetch(backendOrigin + '/api/sandbox/config/reg', { credentials: 'omit', headers: { Cookie: `ticket=${firstTicket}`, 'x-nuwax-native-ticket': 'forged' } }).then((r) => r.json());
    assert.equal(withoutCapability.authorization, null); assert.equal(withoutCapability.cookie, null);

    const wsTest = (win, url) => win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const w=new WebSocket(${JSON.stringify(url)});const timer=setTimeout(()=>{w.close();reject(new Error('WS timeout'));},5000);w.onopen=()=>{clearTimeout(timer);w.close();resolve(true)};w.onerror=()=>{clearTimeout(timer);reject(new Error('WS failed'))}})`);
    await wsTest(direct, backendOrigin.replace('http:', 'ws:') + '/computer/ws-direct'); checkTicket('/computer/ws-direct');
    const external = newWindow(); await external.loadURL(foreignOrigin);
    await external.webContents.executeJavaScript(`fetch(${JSON.stringify(backendOrigin + '/api/untrusted')},{credentials:'include'}).then(r=>r.json())`);
    assert.equal(last('/api/untrusted').authorization, null);
    assert.equal(cookieValue(last('/api/untrusted').cookie, 'ticket'), null);
    console.log('PASS Electron direct login, ticket mirror, public auth, native registration, WS and untrusted origin');

    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const redirectURL = normalizeGatewayRequestUrl({ url: details.url, resourceType: details.resourceType, webContentsUrl: details.webContents?.getURL() ?? '', frameUrl: details.frame?.url, parentFrameUrl: details.frame?.parent?.url, referrer: details.referrer }, { gatewayOrigin: gateway.origin, backendOrigin, backendPrefixes: prefixes });
      interceptions.push({ url: details.url, type: details.resourceType, top: details.webContents?.getURL(), frame: details.frame?.url, parent: details.frame?.parent?.url, referrer: details.referrer, redirectURL });
      callback(redirectURL ? { redirectURL } : {});
    });
    const main = newWindow(); await main.loadURL(gateway.origin + '/home/app');
    assert.equal(await main.webContents.executeJavaScript('fetch("/assets/local.txt").then(r=>r.text())'), 'local-dist');
    const proxied = await main.webContents.executeJavaScript('fetch("/api/proxied").then(r=>r.json())');
    assert.equal(proxied.authorization, null);
    assert.equal(cookieValue(proxied.cookie, 'ticket'), firstTicket);
    assert.equal(cookieValue(proxied.cookie, 'preference'), null, 'only ticket is mirrored across origins');
    await external.webContents.executeJavaScript(`fetch(${JSON.stringify(gateway.origin + '/api/untrusted-gateway')},{mode:'no-cors'}).then(()=>true)`);
    assert.equal(last('/api/untrusted-gateway').authorization, null);
    assert.equal(cookieValue(last('/api/untrusted-gateway').cookie, 'ticket'), null);
    await wsTest(external, gateway.origin.replace('http:', 'ws:') + '/computer/ws-untrusted');
    assert.equal(last('/computer/ws-untrusted').authorization, null);
    assert.equal(cookieValue(last('/computer/ws-untrusted').cookie, 'ticket'), null);
    await wsTest(main, gateway.origin.replace('http:', 'ws:') + '/computer/ws-gateway'); checkTicket('/computer/ws-gateway');
    await wsTest(main, backendOrigin.replace('http:', 'ws:') + '/socket/absolute-ws');
    checkTicket('/socket/absolute-ws');
    const documentUrl = await main.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const f=document.createElement('iframe');f.onload=()=>{try{resolve(f.contentWindow.location.href)}catch(e){reject(e)}};f.onerror=reject;f.src=${JSON.stringify(backendOrigin + '/repo/absolute-document')};document.body.appendChild(f)})`);
    assert.equal(documentUrl, gateway.origin + '/repo/absolute-document');
    const resources = await main.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const f=document.createElement('iframe');f.onload=()=>{Promise.resolve(f.contentWindow.fixturePromise).then(resolve,reject)};f.onerror=reject;f.src='/repo/page';document.body.appendChild(f)})`);
    assert.deepEqual(resources, ['upstream:/files/root', 'upstream:/repo/relative', 'upstream:/files/absolute', null, 'upstream:/files/redirect-result?from=redirect', 'POST:fixture-body', 'module-upstream']);
    for (const url of ['/repo/page', '/files/root', '/repo/relative', '/files/absolute', '/api/absolute-auth', '/files/redirect-result?from=redirect', '/internal/post', '/modules/value.js', '/styles/app.css', '/files/image.svg']) checkTicket(url);
    // CSS images may be requested on the next compositor update.
    for (let i = 0; i < 50 && !last('/files/css-image.svg'); i++) await new Promise((r) => setTimeout(r, 20));
    checkTicket('/files/css-image.svg');
    assert(!requests.some((r) => r.url.startsWith('/__backend/')));
    const blockedNamespace = await main.webContents.executeJavaScript(`fetch(${JSON.stringify(gateway.origin + '/__backend/evil.example/api/me')}).then(r=>r.status)`);
    assert.equal(blockedNamespace, 403);
    const rotated = await main.webContents.executeJavaScript('fetch("/api/rotate").then(r=>r.json())');
    assert.equal(cookieValue(rotated.cookie, 'ticket'), firstTicket);
    await waitFor(async () => currentTicket() === rotatedTicket &&
      (await session.defaultSession.cookies.get({ url: gateway.origin, name: 'ticket' }))[0]?.value === rotatedTicket,
    'gateway ticket rotation to mirror into both jars');
    await direct.webContents.executeJavaScript('fetch("/api/after-rotation").then(r=>r.json())');
    checkTicket('/api/after-rotation', rotatedTicket);
    await main.webContents.executeJavaScript('fetch("/api/after-rotation-gateway").then(r=>r.json())');
    checkTicket('/api/after-rotation-gateway', rotatedTicket);
    const logout = await main.webContents.executeJavaScript('fetch("/api/logout").then(r=>r.json())');
    assert.equal(cookieValue(logout.cookie, 'ticket'), rotatedTicket);
    await waitFor(async () => currentTicket() === null &&
      (await session.defaultSession.cookies.get({ url: backendOrigin, name: 'ticket' })).length === 0 &&
      (await session.defaultSession.cookies.get({ url: gateway.origin, name: 'ticket' })).length === 0,
    'gateway logout to clear both jars');
    await direct.webContents.executeJavaScript('fetch("/api/after-logout").then(r=>r.json())');
    assert.equal(cookieValue(last('/api/after-logout').cookie, 'ticket'), null);
    await main.webContents.executeJavaScript('fetch("/api/after-logout-gateway").then(r=>r.json())');
    assert.equal(cookieValue(last('/api/after-logout-gateway').cookie, 'ticket'), null);
    await wsTest(main, backendOrigin.replace('http:', 'ws:') + '/socket/absolute-ws');
    assert.equal(cookieValue(last('/socket/absolute-ws').cookie, 'ticket'), null);
    console.log('PASS Electron gateway HTTP/WS, iframe resources, ticket rotation/logout, namespace boundary and resource redirect');
    await fs.writeFile(path.join(temp, 'requests.json'), JSON.stringify({ electron: process.versions.electron, requests }, null, 2));
    console.log(`PASS LOOPBACK_LOGIN_SYNC electron=${process.versions.electron} requests=${requests.length}`);
  } finally {
    dns.lookup = originalLookup;
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
