/**
 * 真实 Electron 下载窗口验收：仅使用临时 profile、随机端口和虚构 ticket。
 * 从壳根运行：node scripts/acceptance/download-popup.cjs
 * frame 来源取证：追加 --frame-provenance（仍仅使用虚构页面）。
 * 验证 overlay 源码；不代表安装包或真实后端已经验收。
 */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');

const fixtureEnvironment = 'NUWAX_DOWNLOAD_POPUP_FIXTURE';
const bundlePath = (temp) => path.join(temp, 'main/services/implementation.cjs');

async function launch() {
  const root = path.resolve(__dirname, '../..');
  const fromShell = createRequire(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json'));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nuwax-download-popup-'));
  let child;
  let watchdog;
  try {
    const services = path.join(root, 'overlay/crates/agent-electron-client/src/main/services');
    const baseServices = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/src/main/services');
    await fs.mkdir(path.join(temp, 'main/preload'), { recursive: true });
    // 此验收只测主进程策略，无需真实 IPC bridge 或 renderer 凭据。
    await fs.writeFile(path.join(temp, 'main/preload/webviewPerfBridge.js'), '// Fixture preload: no IPC bridge.\n');
    await fromShell('esbuild').build({
      stdin: {
        contents: [
          `export * from ${JSON.stringify(path.join(services, 'system/webviewPolicy.ts'))};`,
          `export * from ${JSON.stringify(path.join(services, 'sessionAuthInjection.ts'))};`,
          "export { fixtureSettings } from '@fixture/db';",
        ].join('\n'),
        resolveDir: root,
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath(temp),
      external: ['electron'],
      plugins: [{
        name: 'download-popup-fixture-environment',
        setup(build) {
          const stubs = new Map([
            ['electron-log', 'export default {info(){},warn(){},error(){},debug(){}};'],
            ['@shared/constants', 'export const APP_NAME_IDENTIFIER="nuwax", DEFAULT_SERVER_HOST="https://unused.example", WEBVIEW_POPUP_BASE_WIDTH=600, WEBVIEW_POPUP_BASE_HEIGHT=400, WEBVIEW_POPUP_MIN_WIDTH=640, WEBVIEW_POPUP_MIN_HEIGHT=480;'],
            ['@fixture/db', 'export const fixtureSettings=new Map(); export const readSetting=key=>fixtureSettings.get(key)??null; export const writeSetting=(key,value)=>fixtureSettings.set(key,value);'],
            ['@fixture/hostActivity', 'export const attachHostActivityBusinessWindow=()=>{};'],
            ['@fixture/newTaskAvailability', 'export const isGuestNewTaskAvailable=()=>false;'],
          ]);
          build.onResolve({ filter: /^(electron-log|@shared\/constants|@fixture\/db)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
          build.onResolve({ filter: /^(?:\.\.\/)+db$/ }, () => ({ path: '@fixture/db', namespace: 'fixture' }));
          build.onResolve({ filter: /^\.\.\/hostActivity$/ }, () => ({ path: '@fixture/hostActivity', namespace: 'fixture' }));
          build.onResolve({ filter: /^\.\.\/newTaskAvailability$/ }, () => ({ path: '@fixture/newTaskAvailability', namespace: 'fixture' }));
          // overlay 仅包含覆写文件；缺省模块沿用同一 pin 下的真实基座源。
          build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
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
    watchdog = setTimeout(() => {
      console.error('FAIL download-popup fixture exceeded 75 seconds');
      child.kill('SIGKILL');
    }, 75_000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function run() {
  const { app, BrowserWindow, session } = require('electron');
  const temp = process.env[fixtureEnvironment];
  assert(temp, 'fixture must be launched by its Node entry point');
  fsSync.mkdirSync(path.join(temp, 'profile'), { recursive: true });
  app.setPath('userData', path.join(temp, 'profile'));
  app.setPath('sessionData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP popup-business.fixture.test 127.0.0.1, MAP popup-external.fixture.test 127.0.0.1');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  assert.equal(Number(process.versions.electron.split('.')[0]), 40, 'fixture requires Electron 40');

  const { initWebviewPolicy, initSessionAuthInjection, trustInitialBusinessNavigation, fixtureSettings } = require(bundlePath(temp));
  const unhandledErrors = [];
  process.on('unhandledRejection', error => unhandledErrors.push(error));
  const payload = Buffer.from('PK\u0003\u0004 fixture download bytes\n'.repeat(1024));
  const fixtureTicket = 'download-popup-fictional-ticket';
  const requests = [];
  const downloads = [];
  const observedSessions = new Set();
  const shownWindowIds = new Set();
  const finishedDocumentWindowIds = new Set();
  const domReadyWindowIds = new Set();
  const windowPreferences = new Map();
  const windows = [];
  const servers = [];
  const responses = new Set();
  let businessOrigin;
  let externalOrigin;
  let main;
  let activeCase = null;
  const provenanceMode = process.argv.includes('--frame-provenance');
  const frameUrl = (frame) => {
    try { return frame?.url ?? null; } catch { return '<frame-unavailable>'; }
  };
  const contentsDetails = (contents) => contents ? {
    type: contents.getType(), defaultSession: contents.session === session.defaultSession,
    openerUrl: frameUrl(contents.opener),
  } : null;

  const waitFor = async (predicate, label, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    do {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail(`timed out waiting for ${label}`);
  };
  const observeSession = (ses) => {
    if (observedSessions.has(ses)) return;
    observedSessions.add(ses);
    ses.on('will-download', (_event, item, contents) => {
      const entry = {
        label: activeCase?.label, item, sourceId: contents?.id, session: ses,
        savePath: path.join(temp, `download-${downloads.length}.bin`), state: null,
      };
      downloads.push(entry);
      item.setSavePath(entry.savePath);
      item.once('done', (_event, state) => { entry.state = state; });
      if (activeCase?.cancel) setTimeout(() => item.cancel(), 25);
    });
  };
  // 仅记录虚构页面的真实 handler 参数；继续透传完整生产策略。
  app.on('web-contents-created', (_event, contents) => {
    if (provenanceMode) for (const eventName of ['did-start-navigation', 'will-frame-navigate', 'will-redirect', 'did-redirect-navigation']) {
      contents.on(eventName, event => {
        if (activeCase?.diagnostics) console.log('FIXTURE_NAVIGATION_SOURCE', JSON.stringify({
          label: activeCase.label, event: eventName, keys: Object.keys(event),
          url: event.url ?? null, frameUrl: frameUrl(event.frame),
          initiatorUrl: frameUrl(event.initiator), initiatorURLField: event.initiatorURL ?? null,
          ...contentsDetails(contents),
        }));
      });
    }
    const setWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
    contents.setWindowOpenHandler = handler => setWindowOpenHandler(details => {
      if (activeCase?.diagnostics) console.log('FIXTURE_WINDOW_OPEN', JSON.stringify({
        label: activeCase.label, keys: Object.keys(details),
        referrerUrl: details.referrer?.url, features: details.features,
        openerUrl: contents.getURL(), defaultSession: contents.session === session.defaultSession,
      }));
      const response = handler(details);
      if (!provenanceMode || !activeCase?.diagnostics || !response.createWindow) return response;
      const createWindow = response.createWindow;
      return { ...response, createWindow: options => {
        console.log('FIXTURE_CREATE_WINDOW_SOURCE', JSON.stringify({
          label: activeCase.label, keys: Object.keys(options),
          guest: contentsDetails(options.webContents),
        }));
        const created = createWindow(options);
        console.log('FIXTURE_CREATED_CONTENTS_SOURCE', JSON.stringify({ label: activeCase.label, ...contentsDetails(created) }));
        return created;
      } };
    });
  });
  app.on('browser-window-created', (_event, win) => {
    windows.push(win);
    const preferences = win.webContents.getLastWebPreferences();
    windowPreferences.set(win.id, {
      hasPreload: !!preferences.preload,
      hasHostBridgeArguments: preferences.additionalArguments?.some(arg => arg.startsWith('--nuwax-host-product=') || arg.startsWith('--nuwax-trusted-origins=')) ?? false,
    });
    if (win.isVisible()) shownWindowIds.add(win.id);
    win.on('show', () => shownWindowIds.add(win.id));
    win.webContents.on('did-finish-load', () => {
      if (/^https?:/.test(win.webContents.getURL())) finishedDocumentWindowIds.add(win.id);
    });
    win.webContents.on('dom-ready', () => {
      if (/^https?:/.test(win.webContents.getURL())) domReadyWindowIds.add(win.id);
    });
    observeSession(win.webContents.session);
    if (activeCase?.diagnostics) console.log('FIXTURE_POPUP_SESSION', JSON.stringify({
      label: activeCase.label, defaultSession: win.webContents.session === session.defaultSession,
      ...windowPreferences.get(win.id),
    }));
  });
  observeSession(session.defaultSession);

  const requestDetails = (req, side) => ({
    side, path: new URL(req.url, 'http://fixture.test').pathname,
    label: new URL(req.url, 'http://fixture.test').searchParams.get('case'),
    hasTicket: (req.headers.cookie ?? '').split(';').some(part => part.trim() === `ticket=${fixtureTicket}`),
  });
  const writePage = (res, text, contentType = 'text/html') => {
    res.setHeader('Content-Type', contentType);
    res.end(contentType === 'text/html' ? `<html><body>${text}</body></html>` : text);
  };
  const business = createServer((req, res) => {
    const detail = requestDetails(req, 'business');
    requests.push(detail);
    if (detail.path.startsWith('/api/f/s3/')) {
      if (!detail.hasTicket || detail.path.endsWith('/expired')) {
        writePage(res, JSON.stringify({ code: '4010', displayCode: '4010', message: 'Fixture session expired' }), 'application/json');
      } else if (detail.path.endsWith('/direct')) {
        res.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture-direct.bin"', 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
        res.end(payload);
      } else {
        const endpoint = detail.path.endsWith('/cancel') ? '/cancel.bin' : '/attachment.bin';
        res.writeHead(302, { Location: `${externalOrigin}${endpoint}?case=${encodeURIComponent(detail.label)}` });
        res.end();
      }
    } else {
      writePage(res, detail.path === '/trusted-page' ? 'TRUSTED BUSINESS PAGE' : 'BUSINESS FIXTURE PAGE');
    }
  });
  const external = createServer((req, res) => {
    const detail = requestDetails(req, 'external');
    requests.push(detail);
    if (detail.path === '/disconnect') { req.socket.destroy(); return; }
    if (detail.path === '/committed-pending') {
      res.setHeader('Content-Type', 'text/html');
      const resourceUrl = `/pending-resource?case=${encodeURIComponent(detail.label)}`;
      const downloadUrl = `/attachment.bin?case=${encodeURIComponent(detail.label)}`;
      res.end(`<html><body>COMMITTED HTML WITH PENDING RESOURCE<img src="${resourceUrl}"><script>
        document.addEventListener('DOMContentLoaded', () => {
          const link = document.createElement('a');
          link.href = ${JSON.stringify(downloadUrl)}; link.target = '_self';
          document.body.append(link); link.click(); link.remove();
        });
      </script></body></html>`);
    } else if (detail.path === '/pending-resource') {
      // HTML 已提交且 DOMContentLoaded 可触发，但图片阻止 did-finish-load。
      responses.add(res);
      res.once('close', () => responses.delete(res));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 65536 });
      res.flushHeaders();
    } else if (detail.path === '/attachment.bin' || detail.path === '/cancel.bin') {
      res.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture-external.bin"', 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
      if (detail.path === '/cancel.bin') {
        // 下载持续进行，确保 item.cancel() 走真实 cancelled 终态。
        responses.add(res);
        res.once('close', () => responses.delete(res));
        res.write(payload.subarray(0, 256));
      } else res.end(payload);
    } else {
      if (detail.path === '/not-found') res.statusCode = 404;
      writePage(res, detail.path === '/not-found' ? 'EXTERNAL 404 PAGE' : 'EXTERNAL HTML PAGE');
    }
  });
  const listen = async (server, hostname) => {
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return `http://${hostname}:${server.address().port}`;
  };
  const click = async (win, url, target, openMode = 'anchor', linkRel = '') => {
    const action = openMode === 'window.open'
      ? `void window.open(${JSON.stringify(url)}, ${JSON.stringify(target)}, ${JSON.stringify(linkRel.replaceAll(' ', ','))});`
      : `(() => {
      const link = document.createElement('a');
      link.href = ${JSON.stringify(url)}; link.target = ${JSON.stringify(target)};
      link.rel = ${JSON.stringify(linkRel)};
      document.body.append(link); link.click(); link.remove();
    })()`;
    await win.webContents.executeJavaScript(action, true);
  };
  const openPopup = async (label, url, text, linkRel = '') => {
    activeCase = { label, diagnostics: !!linkRel };
    const previous = new Set(BrowserWindow.getAllWindows().map(win => win.id));
    await click(main, url, '_blank', 'anchor', linkRel);
    let popup;
    await waitFor(async () => {
      popup = BrowserWindow.getAllWindows().find(win => !previous.has(win.id));
      return popup && !popup.webContents.isLoading() && popup.webContents.getURL() === url;
    }, `${label}: popup commits its document`);
    assert((await popup.webContents.executeJavaScript('document.body.textContent')).includes(text), `${label}: expected document body is visible`);
    await waitFor(() => popup.isVisible(), `${label}: popup is shown`);
    return popup;
  };
  const assertMainSurvives = () => {
    assert(!main.isDestroyed(), 'main business window must survive downloads');
    assert.equal(main.webContents.getURL(), `${businessOrigin}/`, 'download must not replace the business page');
  };
  const downloadCase = async (label, endpoint, target, cancel = false, openMode = 'anchor', linkRel = '', source = main) => {
    activeCase = { label, cancel, diagnostics: !!linkRel };
    const start = downloads.length;
    const windowStart = windows.length;
    const url = `${endpoint}?case=${encodeURIComponent(label)}`;
    await click(source, url, target, openMode, linkRel);
    await waitFor(() => downloads.length > start, `${label}: real will-download`);
    const download = downloads[start];
    await waitFor(() => download.state !== null, `${label}: download terminal state`);
    assert.equal(download.state, cancel ? 'cancelled' : 'completed', label);
    if (!cancel) assert.deepEqual(await fs.readFile(download.savePath), payload, `${label}: bytes saved intact`);
    await waitFor(() => BrowserWindow.getAllWindows().every(win => win === main), `${label}: download popups destroyed`);
    assert.equal(downloads.length, start + 1, `${label}: only one download`);
    assert(windows.slice(windowStart).every(win => !shownWindowIds.has(win.id)), `${label}: download popups never show blank content`);
    if (linkRel.includes('noreferrer')) for (const win of windows.slice(windowStart)) {
      assert.equal(windowPreferences.get(win.id).hasPreload, false, `${label}: no preload on a noreferrer file window`);
      assert.equal(windowPreferences.get(win.id).hasHostBridgeArguments, false, `${label}: no host bridge arguments on a noreferrer file window`);
    }
    if (endpoint.endsWith('/direct')) assert.equal(download.session, session.defaultSession, `${label}: business download uses default session`);
    else assert.notEqual(download.session, session.defaultSession, `${label}: external download uses an isolated session`);
    assertMainSurvives();
    const ownRequests = requests.filter(req => req.label === label);
    if (endpoint.startsWith(businessOrigin)) {
      assert(ownRequests.some(req => req.side === 'business' && req.hasTicket), `${label}: first business request has HttpOnly ticket`);
      assert(!ownRequests.some(req => req.side === 'business' && !req.hasTicket), `${label}: no unauthenticated business request`);
    }
    for (const req of ownRequests.filter(req => req.side === 'external')) assert.equal(req.hasTicket, false, `${label}: no business ticket at external server`);
    console.log(`PASS ${label}`);
  };

  try {
    businessOrigin = await listen(business, 'popup-business.fixture.test');
    externalOrigin = await listen(external, 'popup-external.fixture.test');
    fixtureSettings.set('step1_config', { serverHost: businessOrigin });
    fixtureSettings.set(`nuwax.ticket.${businessOrigin}`, fixtureTicket);
    await session.defaultSession.cookies.set({ url: businessOrigin, name: 'ticket', value: fixtureTicket, httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
    initSessionAuthInjection(() => ({ businessOrigin, trustedOrigins: [businessOrigin] }));
    initWebviewPolicy(() => main && !main.isDestroyed() ? main : null);
    main = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    trustInitialBusinessNavigation(main.webContents, `${businessOrigin}/`);
    await main.loadURL(`${businessOrigin}/`);

    if (provenanceMode) {
      for (const mode of ['anchor', 'window.open']) await downloadCase(`top-frame-noreferrer-${mode}`, `${businessOrigin}/api/f/s3/redirect`, '_blank', false, mode, 'noopener noreferrer');
      activeCase = null;
      const businessFrameUrl = `${businessOrigin}/same-frame`;
      await main.webContents.executeJavaScript(`new Promise(resolve => {
        const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(businessFrameUrl)};
        frame.onload = () => resolve(true); document.body.append(frame);
      })`, true);
      const businessFrame = main.webContents.mainFrame.frames.find(frame => frame.url === businessFrameUrl);
      assert(businessFrame, 'same-origin iframe is present in the business document');
      for (const mode of ['anchor', 'window.open']) await downloadCase(`same-frame-noreferrer-${mode}`, `${businessOrigin}/api/f/s3/redirect`, '_blank', false, mode, 'noopener noreferrer', { webContents: businessFrame });
      activeCase = null;
      const foreignFrameUrl = `${externalOrigin}/foreign-frame`;
      await main.webContents.executeJavaScript(`new Promise(resolve => {
        const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(foreignFrameUrl)};
        frame.onload = () => resolve(true); document.body.append(frame);
      })`, true);
      const foreignFrame = main.webContents.mainFrame.frames.find(frame => frame.url === foreignFrameUrl);
      assert(foreignFrame, 'external iframe is present in the business document');
      for (const mode of ['anchor', 'window.open']) {
        activeCase = { label: `foreign-frame-noreferrer-${mode}`, diagnostics: true };
        const start = downloads.length;
        const url = `${businessOrigin}/api/f/s3/redirect?case=${encodeURIComponent(activeCase.label)}`;
        // 调用真实外域 WebFrameMain 的执行接口，不借顶层页面身份点击。
        await click({ webContents: foreignFrame }, url, '_blank', mode, 'noopener noreferrer');
        await waitFor(() => requests.some(req => req.label === activeCase.label && req.side === 'business'), `${activeCase.label}: business request observed`);
        await waitFor(() => downloads[start]?.state || BrowserWindow.getAllWindows().some(win => win !== main && !win.webContents.isLoading() && win.webContents.getURL() === url), `${activeCase.label}: download or diagnostic document settles`);
        console.log('FIXTURE_FRAME_PROVENANCE_RESULT', JSON.stringify({
          label: activeCase.label, sourceFrameUrl: foreignFrame.url,
          requests: requests.filter(req => req.label === activeCase.label),
          downloads: downloads.slice(start).map(item => ({ state: item.state })),
        }));
        assert.equal(downloads.length, start, 'an external iframe cannot start an authenticated business download');
        assert(requests.filter(req => req.label === activeCase.label && req.side === 'business').every(req => !req.hasTicket), 'external iframe business requests have no ticket');
        const deniedPopup = BrowserWindow.getAllWindows().find(win => win !== main && win.webContents.getURL() === url);
        assert(deniedPopup, 'external iframe gets a diagnostic document');
        assert.notEqual(deniedPopup.webContents.session, session.defaultSession, 'external iframe noreferrer popup uses isolated session');
        assert.equal(windowPreferences.get(deniedPopup.id).hasPreload, false, 'external iframe gets no preload');
        assert.equal(windowPreferences.get(deniedPopup.id).hasHostBridgeArguments, false, 'external iframe gets no host bridge');
        for (const win of BrowserWindow.getAllWindows()) if (win !== main) win.destroy();
        assertMainSurvives();
        console.log(`PASS ${activeCase.label}`);
      }
      assert.equal(unhandledErrors.length, 0, 'frame provenance observation has no unhandled Promise rejection');
      console.log(`PASS frame-provenance observation Electron=${process.versions.electron}`);
      return;
    }

    for (const target of ['_self', '_blank']) {
      await downloadCase(`business-302-${target}`, `${businessOrigin}/api/f/s3/redirect`, target);
      await downloadCase(`external-${target}`, `${externalOrigin}/attachment.bin`, target);
    }
    await downloadCase('business-direct-_blank', `${businessOrigin}/api/f/s3/direct`, '_blank');
    await downloadCase('business-302-cancelled', `${businessOrigin}/api/f/s3/cancel`, '_blank', true);
    // window.open 的 Chromium guest 创建入口与普通 <a> 不同。
    await downloadCase('business-302-window-open', `${businessOrigin}/api/f/s3/redirect`, '_blank', false, 'window.open');
    await downloadCase('external-window-open', `${externalOrigin}/attachment.bin`, '_blank', false, 'window.open');
    await downloadCase('business-302-noopener-noreferrer', `${businessOrigin}/api/f/s3/redirect`, '_blank', false, 'anchor', 'noopener noreferrer');
    await downloadCase('business-302-window-open-noreferrer', `${businessOrigin}/api/f/s3/redirect`, '_blank', false, 'window.open', 'noopener noreferrer');
    await downloadCase('external-noopener-noreferrer', `${externalOrigin}/attachment.bin`, '_blank', false, 'anchor', 'noopener noreferrer');
    await downloadCase('external-window-open-noreferrer', `${externalOrigin}/attachment.bin`, '_blank', false, 'window.open', 'noopener noreferrer');

    const trusted = await openPopup('trusted-html', `${businessOrigin}/trusted-page`, 'TRUSTED BUSINESS PAGE');
    assert.equal(trusted.webContents.session, session.defaultSession, 'trusted popup shares the business session');
    assert(requests.some(req => req.path === '/trusted-page' && req.hasTicket), 'trusted popup first document is authenticated');
    trusted.destroy();
    console.log('PASS trusted-html');

    const html = await openPopup('external-html', `${externalOrigin}/page`, 'EXTERNAL HTML PAGE');
    assert.notEqual(html.webContents.session, session.defaultSession, 'ordinary external HTML uses isolated session');
    activeCase = { label: 'existing-html-download' };
    const start = downloads.length;
    await click(html, `${externalOrigin}/attachment.bin?case=existing-html-download`, '_self');
    await waitFor(() => downloads[start]?.state === 'completed', 'existing HTML: download completes');
    assert.deepEqual(await fs.readFile(downloads[start].savePath), payload);
    assert(!html.isDestroyed(), 'a popup with committed HTML must survive its subsequent download');
    assert.equal(await html.webContents.executeJavaScript('document.body.textContent'), 'EXTERNAL HTML PAGE');
    html.destroy();
    console.log('PASS existing-html-download');

    activeCase = { label: 'committed-html-download-before-load' };
    const pendingDownloadStart = downloads.length;
    await click(main, `${externalOrigin}/committed-pending?case=${activeCase.label}`, '_blank');
    await waitFor(() => downloads[pendingDownloadStart]?.state === 'completed', 'committed HTML: DOMContentLoaded download completes');
    const pendingDownload = downloads[pendingDownloadStart];
    const pendingHtml = BrowserWindow.getAllWindows().find(win => win.webContents.id === pendingDownload.sourceId);
    assert(pendingHtml, 'a committed HTML popup must survive a download before its resource load finishes');
    assert(requests.some(req => req.label === activeCase.label && req.path === '/pending-resource'), 'the HTML resource started loading');
    assert.equal(finishedDocumentWindowIds.has(pendingHtml.id), false, 'download completed before HTML did-finish-load');
    assert(domReadyWindowIds.has(pendingHtml.id), 'the committed HTML emitted dom-ready');
    assert.equal(pendingHtml.webContents.getURL(), `${externalOrigin}/committed-pending?case=${activeCase.label}`);
    await waitFor(() => pendingHtml.isVisible() && shownWindowIds.has(pendingHtml.id), 'committed HTML is visible while its resource is pending');
    assert.deepEqual(await fs.readFile(pendingDownload.savePath), payload);
    assert.notEqual(pendingDownload.session, session.defaultSession, 'committed external HTML remains in its isolated session');
    assert.equal(downloads.length, pendingDownloadStart + 1, 'committed HTML starts exactly one download');
    assertMainSurvives();
    pendingHtml.destroy();
    console.log('PASS committed-html-download-before-load');

    const notFound = await openPopup('external-404-html', `${externalOrigin}/not-found`, 'EXTERNAL 404 PAGE');
    notFound.destroy();
    console.log('PASS external-404-html');
    const expiredBody = JSON.stringify({ code: '4010', displayCode: '4010', message: 'Fixture session expired' });
    const expired = await openPopup('business-4010-body', `${businessOrigin}/api/f/s3/expired`, expiredBody);
    expired.destroy();
    console.log('PASS business-4010-body');
    const expiredNoreferrer = await openPopup('business-4010-noreferrer-body', `${businessOrigin}/api/f/s3/expired?case=business-4010-noreferrer-body`, expiredBody, 'noopener noreferrer');
    assert.equal(windowPreferences.get(expiredNoreferrer.id).hasPreload, false, '4010 noreferrer file window has no preload');
    assert.equal(windowPreferences.get(expiredNoreferrer.id).hasHostBridgeArguments, false, '4010 noreferrer file window has no host bridge');
    assert(requests.some(req => req.label === 'business-4010-noreferrer-body' && req.hasTicket), '4010 fixture tests an authenticated first request');
    expiredNoreferrer.destroy();
    console.log('PASS business-4010-noreferrer-body');

    activeCase = { label: 'network-failure' };
    const count = downloads.length;
    await click(main, `${externalOrigin}/disconnect?case=network-failure`, '_blank');
    await waitFor(() => requests.some(req => req.label === 'network-failure'), 'network failure requested');
    await waitFor(() => BrowserWindow.getAllWindows().every(win => win === main), 'network failure leaves no blank window');
    assert.equal(downloads.length, count, 'a network failure is not a download');
    assertMainSurvives();
    assert(!requests.some(req => req.side === 'external' && req.hasTicket), 'external requests never contain the business ticket');
    console.log('PASS network-failure');
    assert.equal(unhandledErrors.length, 0, `no unhandled Promise rejection: ${unhandledErrors.map(error => error?.message ?? String(error)).join('; ')}`);
    console.log(`PASS download-popup fixture Electron=${process.versions.electron} downloads=${downloads.length} windowsCreated=${windows.length}`);
  } catch (error) {
    console.error(`FAIL phase=${activeCase?.label ?? 'setup'} ${error.message}`);
    if (activeCase?.diagnostics) console.error('FIXTURE_REQUESTS', JSON.stringify(requests.filter(req => req.label === activeCase.label)));
    throw error;
  } finally {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    const closedServers = servers.map(server => new Promise(resolve => server.close(resolve)));
    for (const res of responses) res.destroy();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(closedServers);
    await Promise.all([...observedSessions].map(ses => ses.clearStorageData()));
  }
}

if (process.versions.electron) {
  run().then(() => require('electron').app.exit(0)).catch(error => {
    console.error('FAIL download-popup fixture', error.stack ?? error.message);
    require('electron').app.exit(1);
  });
} else {
  launch().catch(error => { console.error('FAIL download-popup fixture', error.stack ?? error.message); process.exitCode = 1; });
}
