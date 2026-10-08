/**
 * Real Electron acceptance for commercial iframe headers and /page routing.
 * node scripts/acceptance/iframe-embedding-compat.cjs [--live-web]
 * Builds the overlay source with the pinned Electron runtime. Uses an isolated
 * profile and fictional cookies; it does not validate a packaged installer.
 * --live-web adds anonymous, GET-only smoke checks of the two discussed sites.
 */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');

const fixtureEnvironment = 'NUWAX_IFRAME_EMBEDDING_FIXTURE';
const firstTicket = 'iframe-fixture-first';
const rotatedTicket = 'iframe-fixture-rotated';
const pagePath = '/page/fixture/prod/';
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const timeout = async (promise, label, ms = 12000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
};
const cookieValue = (header, name) => header?.split(';').map(value => value.trim())
  .find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

function protectedHeaders(res, variant = 'all') {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  if (variant !== 'csp' && variant !== 'report-only') res.setHeader('X-Frame-Options', 'DENY');
  if (variant !== 'xfo' && variant !== 'report-only') res.setHeader('Content-Security-Policy', variant === 'multiple'
    ? ["default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'none'; frame-src *; FrAmE-AnCeStOrS 'none'", "object-src 'none'; FRAME-ANCESTORS https://never.fixture.test, style-src 'none'; frame-ancestors 'none'"]
    : "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'none'; frame-src *; style-src 'none'; FrAmE-AnCeStOrS 'none'");
  if (variant !== 'xfo') res.setHeader('Content-Security-Policy-Report-Only', ["frame-ancestors 'none'; object-src 'none'", "FRAME-ANCESTORS https://never.fixture.test; style-src 'none'"]);
}

async function launch() {
  const root = path.resolve(__dirname, '../..');
  const fromShell = createRequire(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json'));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nuwax-iframe-embedding-'));
  const requests = [];
  const servers = [];
  let child;
  let watchdog;
  let backendOrigin;
  const listen = async handler => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const markerDocument = marker => `<html><body><h1>${marker}</h1><script>
    window.fixtureMarker=${JSON.stringify(marker)};
    parent.postMessage({fixtureMarker:window.fixtureMarker},'*');
    </script><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" onerror="parent.postMessage({cspImageBlocked:window.fixtureMarker},'*')"></body></html>`;
  try {
    const services = path.join(root, 'overlay/crates/agent-electron-client/src/main/services');
    const baseServices = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/src/main/services');
    await fromShell('esbuild').build({
      stdin: {
        contents: [
          `export * from ${JSON.stringify(path.join(services, 'frameEmbeddingPolicy.ts'))};`,
          `export * from ${JSON.stringify(path.join(services, 'loopbackGateway/gateway.ts'))};`,
          `export * from ${JSON.stringify(path.join(services, 'loopbackGateway/routingPolicy.ts'))};`,
          `export { MICROAPP_BACKEND_PREFIXES } from ${JSON.stringify(path.join(services, 'loopbackGateway/index.ts'))};`,
        ].join('\n'),
        resolveDir: root,
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temp, 'implementation.cjs'),
      external: ['electron'],
      plugins: [{
        name: 'iframe-fixture-environment',
        setup(build) {
          const stubs = new Map([
            ['electron-log', 'export default {info(){},warn(){},error(){},debug(){}};'],
            ['@shared/constants', 'export const APP_NAME_IDENTIFIER="nuwax", DEFAULT_SERVER_HOST="https://unused.example";'],
            ['@fixture/db', 'export const readSetting=()=>null; export const writeSetting=()=>{};'],
            ['@fixture/startupPorts', 'export const getConfiguredPorts=()=>({});'],
          ]);
          build.onResolve({ filter: /^(electron-log|@shared\/constants)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
          build.onResolve({ filter: /^(?:\.\.\/)+db$/ }, () => ({ path: '@fixture/db', namespace: 'fixture' }));
          build.onResolve({ filter: /^\.\.\/startupPorts$/ }, () => ({ path: '@fixture/startupPorts', namespace: 'fixture' }));
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
    backendOrigin = await listen((req, res) => {
      const pathname = new URL(req.url, backendOrigin).pathname;
      requests.push({ pathname, method: req.method, ticket: cookieValue(req.headers.cookie, 'ticket') });
      if (pathname === '/redirect') {
        protectedHeaders(res); res.writeHead(302, { Location: '/headers/multiple' }); res.end(); return;
      }
      if (pathname.startsWith('/headers/')) {
        const variant = pathname.slice('/headers/'.length);
        protectedHeaders(res, variant);
        res.end(markerDocument(`loaded:${variant}`)); return;
      }
      if (pathname === '/nested') {
        protectedHeaders(res);
        res.end('<html><body>nested-outer<iframe src="/headers/multiple"></iframe><script>addEventListener("message",e=>parent.postMessage(e.data,"*"))</script></body></html>'); return;
      }
      if (pathname.startsWith('/cookies/')) {
        protectedHeaders(res, 'multiple');
        const cookies = [
          'preference=retained; Path=/; Max-Age=3600; SameSite=Lax',
          `experiment=independent; Path=/; Expires=${new Date(Date.now() + 3600000).toUTCString()}; SameSite=Lax`,
        ];
        if (pathname === '/cookies/login') cookies.unshift(`ticket=${firstTicket}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`);
        if (pathname === '/cookies/rotate' || pathname === '/cookies/persist') cookies.unshift(`ticket=${rotatedTicket}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`);
        if (pathname === '/cookies/logout') cookies.unshift('ticket=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
        if (pathname !== '/cookies/check') res.setHeader('Set-Cookie', cookies);
        res.end(markerDocument(`cookie:${pathname.slice('/cookies/'.length)}`)); return;
      }
      if (pathname === pagePath) {
        protectedHeaders(res);
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; frame-ancestors 'none'");
        res.end(`<html><body><h1 id="application">upstream-page-application</h1>
          <link rel="stylesheet" href="/page-fixture-style.css"><script type="module" src="/page-fixture-root.js"></script>
          <script>window.fixturePromise=Promise.all([
            fetch('relative.txt').then(r=>r.text()), fetch('/page-fixture-root.txt').then(r=>r.text()),
            fetch('/page-fixture-redirect').then(r=>r.text())
          ]).then(async values=>{for(let i=0;i<100&&!window.fixtureModuleValue;i++)await new Promise(r=>setTimeout(r,20));
            values.push(window.fixtureModuleValue);window.fixtureResources=values;parent.postMessage({pageResources:values},'*');return values});</script>
          </body></html>`); return;
      }
      if (pathname === '/page-fixture-redirect') { res.writeHead(302, { Location: '/page-fixture-redirect-result' }); res.end(); return; }
      if (pathname === '/page-fixture-root.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('import {value} from "/page-fixture-nested.js";window.fixtureModuleValue=value;'); return; }
      if (pathname === '/page-fixture-nested.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('export const value="upstream-module";'); return; }
      if (pathname === '/page-fixture-style.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{background-image:url("/page-fixture-image.svg");color:rgb(20,30,40)}'); return; }
      if (pathname === '/page-fixture-image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); return; }
      res.setHeader('Content-Type', 'text/plain');
      res.end(`upstream:${pathname}`);
    });
    const parentOrigin = await listen((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Local iframe acceptance parent</h1><script>window.fixtureMessages=[];addEventListener("message",e=>{if(e.data&&typeof e.data==="object")fixtureMessages.push(e.data)})</script></body></html>');
    });
    await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify({ backendOrigin, parentOrigin }));
    const runChild = async stage => {
      const env = { ...process.env, [fixtureEnvironment]: temp, NUWAX_IFRAME_STAGE: stage };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(fromShell('electron'), [__filename], { env, stdio: 'inherit' });
      watchdog = setTimeout(() => {
        console.error(`FAIL iframe acceptance ${stage} exceeded 90 seconds`);
        child.kill('SIGKILL');
      }, 90000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      });
      clearTimeout(watchdog);
      assert.equal(code, 0, `Electron ${stage} fixture failed`);
    };
    await runChild('initial');
    for (const [pathname, expectedTicket] of [['/cookies/rotate', firstTicket], ['/cookies/logout', rotatedTicket], ['/cookies/persist', null]]) {
      const matches = requests.filter(request => request.pathname === pathname);
      assert.equal(matches.length, 3, `${pathname}: every tested session must issue a real request`);
      assert(matches.every(request => request.ticket === expectedTicket), `${pathname}: HTTP must use the current ticket before applying the response`);
    }
    for (const pathname of [pagePath, pagePath + 'relative.txt', '/page-fixture-root.txt', '/page-fixture-redirect-result', '/page-fixture-root.js', '/page-fixture-nested.js', '/page-fixture-style.css', '/page-fixture-image.svg']) {
      assert(requests.some(request => request.pathname === pathname), `${pathname}: backend application/resource must reach the real upstream`);
    }
    const afterInitial = requests.length;
    await runChild('restart');
    const restartRequests = requests.slice(afterInitial).filter(request => request.pathname === '/cookies/check');
    assert.equal(restartRequests.length, 2, 'default and persistent partition must both make real post-restart requests');
    assert(restartRequests.every(request => request.ticket === rotatedTicket), 'post-restart HTTP requests must retain the rotated HttpOnly ticket');
    if (process.argv.includes('--live-web')) await runChild('live');
    await fs.writeFile(path.join(temp, 'request-summary.json'), JSON.stringify({
      sourceFixture: true, installerValidated: false,
      requests: requests.map(({ pathname, method, ticket }) => ({ pathname, method, hasFictionalTicket: !!ticket })),
    }, null, 2));
    console.log(`PASS IFRAME_EMBEDDING_COMPAT source-fixture requests=${requests.length} cookieRestartProcesses=2`);
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    console.log(`FIXTURE_ARTIFACTS ${temp}`);
  }
}

async function run() {
  const { app, BrowserWindow, session, webContents } = require('electron');
  const temp = process.env[fixtureEnvironment];
  const stage = process.env.NUWAX_IFRAME_STAGE;
  const { backendOrigin, parentOrigin } = JSON.parse(await fs.readFile(path.join(temp, 'config.json'), 'utf8'));
  const profile = path.join(temp, stage === 'live' ? 'anonymous-live-profile' : 'profile');
  fsSync.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.commandLine.appendSwitch('no-proxy-server');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { initFrameEmbeddingPolicy, startLoopbackGateway, normalizeGatewayRequestUrl, DEFAULT_BACKEND_PREFIXES, MICROAPP_BACKEND_PREFIXES } = require(path.join(temp, 'implementation.cjs'));
  const windows = [];
  const failures = [];
  let gateway;
  const newWindow = ses => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 850,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => failures.push({ code, isMainFrame }));
    windows.push(win); return win;
  };
  const waitFor = async (predicate, label, ms = 8000) => {
    const deadline = Date.now() + ms;
    do { if (await predicate()) return; await pause(30); } while (Date.now() < deadline);
    assert.fail(`timed out waiting for ${label}`);
  };
  const load = (win, url) => timeout(win.loadURL(url), 'document load');
  const embed = async (win, url, expected, expectedCsp = false) => {
    await win.webContents.executeJavaScript(`(()=>{fixtureMessages=[];document.querySelectorAll('iframe').forEach(f=>f.remove());const f=document.createElement('iframe');f.style='width:1050px;height:650px';f.src=${JSON.stringify(url)};document.body.appendChild(f)})()`);
    await waitFor(() => win.webContents.executeJavaScript(`fixtureMessages.some(m=>m.fixtureMarker===${JSON.stringify(expected)})`), `iframe ${expected}`);
    if (expectedCsp) await waitFor(() => win.webContents.executeJavaScript(`fixtureMessages.some(m=>m.cspImageBlocked===${JSON.stringify(expected)})`), `preserved img-src ${expected}`);
  };
  const assertJar = async (ses, expectedTicket) => {
    const jar = await ses.cookies.get({ url: backendOrigin });
    assert.equal(jar.find(cookie => cookie.name === 'ticket')?.value ?? null, expectedTicket);
    assert.equal(jar.find(cookie => cookie.name === 'preference')?.value, 'retained');
    assert.equal(jar.find(cookie => cookie.name === 'experiment')?.value, 'independent');
    if (expectedTicket) assert.equal(jar.find(cookie => cookie.name === 'ticket').httpOnly, true);
  };
  try {
    if (stage === 'initial') {
      const blocked = newWindow(session.defaultSession);
      await load(blocked, parentOrigin);
      await blocked.webContents.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.src=${JSON.stringify(backendOrigin + '/headers/all')};document.body.appendChild(f)})()`);
      await pause(1200);
      assert.equal(await blocked.webContents.executeJavaScript('fixtureMessages.length'), 0, 'unmodified CSP/XFO must block the iframe');
      console.log('PASS reproduced original frame-ancestors/XFO denial');
    }
    initFrameEmbeddingPolicy({ app, defaultSession: session.defaultSession, isCommercial: true, isDev: false });
    if (stage === 'live') {
      let deniedWrites = 0;
      let liveRoutingConfig;
      const liveRequests = [];
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        const cancel = details.resourceType === 'webSocket' || !['GET', 'HEAD', 'OPTIONS'].includes(details.method);
        if (cancel) { deniedWrites++; callback({ cancel: true }); return; }
        const source = details.webContents ?? (details.webContentsId > 0 ? webContents.fromId(details.webContentsId) : undefined);
        const redirectURL = liveRoutingConfig ? normalizeGatewayRequestUrl({ url: details.url, resourceType: details.resourceType,
          webContentsUrl: source?.getURL() ?? '', frameUrl: details.frame?.url, parentFrameUrl: details.frame?.parent?.url,
          referrer: details.referrer }, liveRoutingConfig) : null;
        callback(redirectURL ? { redirectURL } : {});
      });
      session.defaultSession.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, details => {
        const url = new URL(details.url);
        const mime = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.[0] ?? '';
        liveRequests.push({ origin: url.origin, pathname: url.pathname, method: details.method, type: details.resourceType, statusCode: details.statusCode, mime });
      });
      const liveEvidence = [];
      const liveUrls = ['https://demo-x.yichamao.com/', 'https://agent.nuwax.com/page/5814571981017088-33289485/prod/'];
      const domExpression = `({origin:location.origin,pathname:location.pathname,readyState:document.readyState,title:document.title.slice(0,120),bodyTextLength:document.body?.innerText.length??0,scriptCount:document.scripts.length,stylesheetCount:document.styleSheets.length,imageCount:document.images.length,loadedImageCount:[...document.images].filter(image=>image.complete&&image.naturalWidth>0).length})`;
      const assertLiveDom = (dom, title, label) => {
        assert.equal(dom.readyState, 'complete', `${label}: document must finish loading`);
        assert.equal(dom.title, title, `${label}: expected application title must render`);
        assert(dom.bodyTextLength > 0, `${label}: document body must render`);
        assert(dom.scriptCount > 0, `${label}: application scripts must exist`);
        assert(dom.loadedImageCount > 0, `${label}: application image resources must load`);
      };
      for (let index = 0; index < liveUrls.length; index++) {
        const win = newWindow(session.defaultSession);
        await load(win, parentOrigin);
        await win.webContents.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.style='width:1100px;height:720px';f.src=${JSON.stringify(liveUrls[index])};document.body.appendChild(f)})()`);
        await pause(8000);
        const frame = win.webContents.mainFrame.frames.find(candidate => candidate.url.startsWith(new URL(liveUrls[index]).origin + '/'));
        assert(frame, `${liveUrls[index]}: expected HTTPS iframe must exist`);
        const dom = await timeout(frame.executeJavaScript(domExpression), 'anonymous live DOM read', 5000);
        const screenshot = path.join(temp, `live-${index + 1}.png`);
        await fs.writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
        assertLiveDom(dom, index === 0 ? 'TexLite' : '女娲人工智能学院', `direct HTTPS iframe ${index + 1}`);
        const evidence = { target: liveUrls[index], anonymous: true, readOnly: true, installerValidated: false, asserted: true, frames: [dom], screenshot };
        liveEvidence.push(evidence);
        console.log(`PASS LIVE_HTTPS_IFRAME ${new URL(liveUrls[index]).hostname} title/body/images asserted`);
        win.destroy();
      }
      const academyUrl = new URL(liveUrls[1]);
      const prefixes = [...DEFAULT_BACKEND_PREFIXES, ...MICROAPP_BACKEND_PREFIXES];
      assert(prefixes.includes('/page'), 'live academy must use the production /page registration');
      const dist = path.join(temp, 'anonymous-live-dist');
      await fs.mkdir(dist, { recursive: true });
      await fs.writeFile(path.join(dist, 'index.html'), '<html><head><title>IFRAME_FIXTURE_PARENT</title></head><body><h1>Local loopback acceptance parent</h1></body></html>');
      gateway = await startLoopbackGateway({ targetOrigin: academyUrl.origin, distDir: dist, backendPrefixes: prefixes, fixedPort: 0, getTicket: () => null, clientTypeHeader: 'nuwax' });
      liveRoutingConfig = { gatewayOrigin: gateway.origin, backendOrigin: academyUrl.origin, backendPrefixes: prefixes };
      const loopbackUrl = gateway.origin + academyUrl.pathname;
      const loopbackParent = newWindow(session.defaultSession);
      await load(loopbackParent, gateway.origin + '/home');
      const resourceStart = liveRequests.length;
      await loopbackParent.webContents.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.style='width:1100px;height:720px';f.src=${JSON.stringify(academyUrl.href)};document.body.appendChild(f)})()`);
      await pause(8000);
      const loopbackFrame = loopbackParent.webContents.mainFrame.frames.find(frame => frame.url === loopbackUrl);
      assert(loopbackFrame, 'absolute academy iframe must normalize to the loopback /page document');
      assert.equal(await loopbackParent.webContents.executeJavaScript('document.querySelector("iframe").contentWindow.location.href'), loopbackUrl, 'academy iframe must retain the /page deployment path');
      const loopbackDom = await timeout(loopbackFrame.executeJavaScript(domExpression), 'loopback academy DOM read', 5000);
      const loopbackScreenshot = path.join(temp, 'live-academy-loopback-iframe.png');
      await fs.writeFile(loopbackScreenshot, (await loopbackParent.webContents.capturePage()).toPNG());
      assertLiveDom(loopbackDom, '女娲人工智能学院', 'loopback academy iframe');
      assert(loopbackDom.stylesheetCount > 0, 'loopback academy stylesheet resources must load');
      const loopbackResources = liveRequests.slice(resourceStart).filter(request => request.origin === gateway.origin && ['script', 'stylesheet'].includes(request.type));
      assert(loopbackResources.length > 0, 'loopback academy must load application JS/CSS through the gateway');
      assert(loopbackResources.every(request => request.statusCode >= 200 && request.statusCode < 400 && !request.mime.toLowerCase().includes('text/html')), 'application JS/CSS must return upstream resources rather than the local main SPA');
      liveEvidence.push({ target: liveUrls[1], mode: 'loopback-absolute-iframe', finalUrl: loopbackUrl, anonymous: true, readOnly: true, asserted: true, frames: [loopbackDom], resources: loopbackResources, screenshot: loopbackScreenshot });
      const top = newWindow(session.defaultSession);
      await load(top, loopbackUrl);
      await pause(4000);
      assert.equal(top.webContents.getURL(), loopbackUrl, 'top-level academy must retain the loopback /page URL');
      const topDom = await top.webContents.executeJavaScript(domExpression);
      assertLiveDom(topDom, '女娲人工智能学院', 'top-level loopback academy');
      const reloaded = new Promise(resolve => top.webContents.once('did-finish-load', resolve));
      top.webContents.reload();
      await timeout(reloaded, 'live academy top-level reload', 20000);
      await pause(4000);
      const refreshedDom = await top.webContents.executeJavaScript(domExpression);
      assertLiveDom(refreshedDom, '女娲人工智能学院', 'refreshed loopback academy');
      assert.equal(top.webContents.getURL(), loopbackUrl, 'refresh must keep the academy loopback path');
      const topScreenshot = path.join(temp, 'live-academy-loopback-top-level.png');
      await fs.writeFile(topScreenshot, (await top.webContents.capturePage()).toPNG());
      liveEvidence.push({ target: liveUrls[1], mode: 'loopback-top-level-and-refresh', finalUrl: loopbackUrl, anonymous: true, readOnly: true, asserted: true, frames: [topDom, refreshedDom], screenshot: topScreenshot });
      assert.equal((await session.defaultSession.cookies.get({ name: 'ticket' })).length, 0, 'live acceptance must remain anonymous without a ticket cookie');
      await fs.writeFile(path.join(temp, 'live-evidence.json'), JSON.stringify({ electron: process.versions.electron, deniedWrites, failures, results: liveEvidence, requests: liveRequests }, null, 2));
      console.log(`PASS LIVE_LOOPBACK_ACADEMY iframe/top-level/refresh, production routes and upstream JS/CSS; deniedWrites=${deniedWrites}; real login is not asserted`);
      return;
    }
    const persistent = session.fromPartition('persist:iframe-embedding-fixture');
    if (stage === 'restart') {
      for (const [label, ses] of [['default', session.defaultSession], ['persistent', persistent]]) {
        const win = newWindow(ses);
        await assertJar(ses, rotatedTicket);
        await load(win, backendOrigin + '/cookies/check');
        await assertJar(ses, rotatedTicket);
        await load(win, parentOrigin);
        await embed(win, backendOrigin + '/headers/multiple', 'loaded:multiple', true);
        await load(win, backendOrigin + '/cookies/logout');
        await assertJar(ses, null);
        await ses.cookies.flushStore();
        console.log(`PASS ${label} cookies restored in a second Electron process and logout clears ticket`);
      }
      await fs.writeFile(path.join(temp, 'restart-evidence.json'), JSON.stringify({ electron: process.versions.electron, cookieRestartVerified: true, logoutVerified: true, failures }, null, 2));
      return;
    }
    const isolated = session.fromPartition('iframe-embedding-temporary');
    for (const [label, ses] of [['default', session.defaultSession], ['temporary', isolated], ['persistent', persistent]]) {
      const win = newWindow(ses);
      await load(win, parentOrigin);
      for (const variant of ['xfo', 'csp', 'report-only', 'multiple']) await embed(win, backendOrigin + '/headers/' + variant, `loaded:${variant}`, variant !== 'xfo' && variant !== 'report-only');
      await embed(win, backendOrigin + '/redirect', 'loaded:multiple', true);
      await embed(win, backendOrigin + '/nested', 'loaded:multiple', true);
      await load(win, backendOrigin + '/cookies/login');
      await assertJar(ses, firstTicket);
      assert(!(await win.webContents.executeJavaScript('document.cookie')).includes('ticket='), 'ticket remains HttpOnly');
      await load(win, backendOrigin + '/cookies/rotate');
      await assertJar(ses, rotatedTicket);
      await load(win, backendOrigin + '/cookies/logout');
      await assertJar(ses, null);
      await load(win, backendOrigin + '/cookies/persist');
      await assertJar(ses, rotatedTicket);
      if (label !== 'temporary') await ses.cookies.flushStore();
      console.log(`PASS ${label} session CSP/XFO/multiple policies, redirect, nested iframe, retained CSP and multiple cookies/rotation/logout`);
    }
    assert(MICROAPP_BACKEND_PREFIXES.includes('/page'), 'production microapp roots must register /page');
    const prefixes = [...DEFAULT_BACKEND_PREFIXES, ...MICROAPP_BACKEND_PREFIXES];
    const dist = path.join(temp, 'dist');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<html><body><h1>WRONG_MAIN_SPA</h1><script>window.fixtureMessages=[];addEventListener("message",e=>fixtureMessages.push(e.data))</script></body></html>');
    await fs.writeFile(path.join(dist, 'page-fixture-root.js'), 'window.fixtureModuleValue="WRONG_LOCAL_MODULE"');
    await fs.writeFile(path.join(dist, 'page-fixture-root.txt'), 'WRONG_LOCAL_RESOURCE');
    gateway = await startLoopbackGateway({ targetOrigin: backendOrigin, distDir: dist, backendPrefixes: prefixes, fixedPort: 0, getTicket: () => null, clientTypeHeader: 'nuwax' });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const source = details.webContents ?? (details.webContentsId > 0 ? webContents.fromId(details.webContentsId) : undefined);
      const redirectURL = normalizeGatewayRequestUrl({ url: details.url, resourceType: details.resourceType,
        webContentsUrl: source?.getURL() ?? '', frameUrl: details.frame?.url, parentFrameUrl: details.frame?.parent?.url,
        referrer: details.referrer }, { gatewayOrigin: gateway.origin, backendOrigin, backendPrefixes: prefixes });
      callback(redirectURL ? { redirectURL } : {});
    });
    const expectedResources = ['upstream:' + pagePath + 'relative.txt', 'upstream:/page-fixture-root.txt', 'upstream:/page-fixture-redirect-result', 'upstream-module'];
    const top = newWindow(session.defaultSession);
    await load(top, gateway.origin + pagePath);
    assert.equal(await top.webContents.executeJavaScript('document.querySelector("#application")?.textContent'), 'upstream-page-application');
    assert.deepEqual(await timeout(top.webContents.executeJavaScript('fixturePromise'), '/page top-level resources'), expectedResources);
    assert.equal(await top.webContents.executeJavaScript('getComputedStyle(document.body).color'), 'rgb(20, 30, 40)');
    const reloaded = new Promise(resolve => top.webContents.once('did-finish-load', resolve));
    top.webContents.reload();
    await timeout(reloaded, '/page top-level reload');
    assert.deepEqual(await timeout(top.webContents.executeJavaScript('fixturePromise'), '/page reloaded resources'), expectedResources);
    await fs.writeFile(path.join(temp, 'page-top-level.png'), (await top.webContents.capturePage()).toPNG());
    const parent = newWindow(session.defaultSession);
    await load(parent, gateway.origin + '/home');
    await parent.webContents.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.src=${JSON.stringify(backendOrigin + pagePath)};document.body.appendChild(f)})()`);
    await waitFor(() => parent.webContents.executeJavaScript('fixtureMessages.some(m=>m.pageResources)'), '/page iframe resources');
    const iframeResult = await parent.webContents.executeJavaScript('({url:document.querySelector("iframe").contentWindow.location.href,resources:fixtureMessages.find(m=>m.pageResources).pageResources,marker:document.querySelector("iframe").contentDocument.querySelector("#application")?.textContent})');
    assert.equal(iframeResult.url, gateway.origin + pagePath);
    assert.equal(iframeResult.marker, 'upstream-page-application');
    assert.deepEqual(iframeResult.resources, expectedResources);
    await parent.webContents.executeJavaScript('fixtureMessages=[];document.querySelector("iframe").contentWindow.location.reload()');
    await waitFor(() => parent.webContents.executeJavaScript('fixtureMessages.some(m=>m.pageResources)'), '/page iframe reload');
    assert.deepEqual(await parent.webContents.executeJavaScript('fixtureMessages.find(m=>m.pageResources).pageResources'), expectedResources);
    await fs.writeFile(path.join(temp, 'page-iframe.png'), (await parent.webContents.capturePage()).toPNG());
    console.log('PASS production /page root, top-level and absolute-URL iframe/reload, relative/root resources, CSS/module imports and redirects');
    await fs.writeFile(path.join(temp, 'initial-evidence.json'), JSON.stringify({ electron: process.versions.electron,
      sourceFixture: true, installerValidated: false, sessions: ['default', 'temporary', 'persistent'],
      blockedBaselineVerified: true, otherCspDirectivesPreserved: true, multipleCookiesVerified: true,
      pageTopLevelAndIframeVerified: true, pageResourceResults: expectedResources, failures }, null, 2));
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    if (gateway) await gateway.close();
    app.quit();
  }
}

if (process.versions.electron && process.env[fixtureEnvironment]) {
  run().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  launch().catch(error => { console.error(error); process.exitCode = 1; });
}
