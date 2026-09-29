/**
 * 真实 Electron webview + 生产 preload/React 选择器的受控验收。
 * 使用临时 profile、随机 HTTP 端口、虚构电脑数据，不访问真实账号或启停业务服务。
 * 从壳根运行：node scripts/acceptance/computer-list-refresh.cjs
 * 验证源代码通知与列表刷新链路，不代表生产后端或安装包验收。
 */
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');

const fixtureEnvironment = 'NUWAX_COMPUTER_LIST_FIXTURE';

async function launch() {
  const root = path.resolve(__dirname, '../..');
  const shell = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
  const overlay = path.join(root, 'overlay/crates/agent-electron-client/src');
  const frontend = path.join(root, 'nuwax');
  const fromShell = createRequire(path.join(shell, 'package.json'));
  const esbuild = fromShell('esbuild');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nuwax-computer-list-'));
  let child;
  let watchdog;
  try {
    const shellPlugin = {
      name: 'commercial-fixture-constants',
      setup(build) {
        build.onResolve({ filter: /^@shared\/constants$/ }, () => ({ path: 'constants', namespace: 'fixture' }));
        build.onResolve({ filter: /^@shared\// }, args => ({ path: path.join(overlay, 'shared', args.path.slice('@shared/'.length) + '.ts') }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const APP_NAME_IDENTIFIER="nuwax";', loader: 'js' }));
      },
    };
    await esbuild.build({
      entryPoints: [path.join(overlay, 'preload/webviewPerfBridge.ts')],
      bundle: true, platform: 'node', format: 'cjs',
      outfile: path.join(temp, 'preload.cjs'), external: ['electron'],
      plugins: [shellPlugin],
    });
    await esbuild.build({
      entryPoints: [path.join(overlay, 'main/services/computerServiceState.ts')],
      bundle: true, platform: 'node', format: 'cjs',
      outfile: path.join(temp, 'state-bridge.cjs'), external: ['electron'],
      plugins: [shellPlugin],
    });
    await esbuild.build({
      stdin: {
        contents: `import React, {useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import ComputerTypeSelector from '@/components/ChatInputHome/ComputerTypeSelector';
          import {initHostBridgeEvents} from '@/services/hostBridgeEvents';
          import {getComputerServiceState} from '@/services/computerServiceState';
          let root, dispose;
          window.fixtureMount = () => {
            dispose = initHostBridgeEvents({setSecondMenuCollapsed(){}, createNewTask(){}});
            root = createRoot(document.getElementById('root'));
            function Fixture() {
              const [value, setValue] = useState('');
              window.fixtureValue = value;
              return <ComputerTypeSelector value={value} agentId={7} strictAgentMemory
                onChange={id => setValue(id)} />;
            }
            root.render(<Fixture />);
          };
          window.fixtureState = getComputerServiceState;
          window.fixtureUnmount = () => {root?.unmount(); dispose?.();};`,
        resolveDir: frontend, loader: 'tsx',
      },
      bundle: true, platform: 'browser', format: 'iife',
      outfile: path.join(temp, 'frontend.js'),
      nodePaths: [path.join(frontend, 'node_modules')],
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [{
        name: 'controlled-api-and-presentation',
        setup(build) {
          const stubs = new Map([
            ['@/components/base', 'export const SvgIcon=()=>null;'],
            ['@/services/systemManage', `export const apiGetUserSelectableSandboxList=()=>fetch('/api/sandbox/config/select/list').then(r=>r.json());
              export const apiSaveSelectedSandbox=(agentId,sandboxId)=>fetch('/fixture/selection',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId,sandboxId})}).then(r=>r.json());`],
            ['@/services/i18nRuntime', 'export const dict=key=>({"PC.Components.ComputerTypeSelector.selectComputer":"选择电脑","PC.Components.ComputerTypeSelector.noComputerAvailable":"暂无可用电脑"})[key]??key; export const markLangUserSet=()=>{}; export const setCurrentLang=()=>{}; export const fetchAndApplyLangMap=async()=>{};'],
            ['@/services/i18n', 'export const saveUserLang=async()=>{};'],
            ['@/services/i18nLangPolicy', 'export const normalizeLang=value=>value;'],
          ]);
          build.onResolve({ filter: /^@\// }, args => {
            if (stubs.has(args.path)) return { path: args.path, namespace: 'fixture-api' };
            const base = path.join(frontend, 'src', args.path.slice(2));
            const file = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']
              .map(suffix => base + suffix)
              .find(file => fsSync.existsSync(file) && fsSync.statSync(file).isFile());
            if (file) return { path: file };
          });
          build.onLoad({ filter: /.*/, namespace: 'fixture-api' }, args => ({ contents: stubs.get(args.path), loader: 'js' }));
          build.onLoad({ filter: /\.less$/ }, args => {
            const source = fsSync.readFileSync(args.path, 'utf8');
            const classes = [...source.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
            return { contents: `export default ${JSON.stringify(Object.fromEntries(classes.map(name => [name, name])))};`, loader: 'js' };
          });
        },
      }],
    });
    const env = { ...process.env, [fixtureEnvironment]: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(fromShell('electron'), [__filename], { env, stdio: 'inherit' });
    watchdog = setTimeout(() => {
      console.error('FAIL computer-list fixture exceeded 60 seconds');
      child.kill('SIGKILL');
    }, 60_000);
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
  const { app, BrowserWindow, session, ipcMain } = require('electron');
  const temp = process.env[fixtureEnvironment];
  fsSync.mkdirSync(path.join(temp, 'profile'), { recursive: true });
  app.setPath('userData', path.join(temp, 'profile'));
  app.setPath('sessionData', path.join(temp, 'profile'));
  app.commandLine.appendSwitch('no-proxy-server');
  app.on('window-all-closed', () => {});
  await app.whenReady();

  let localAvailable = false;
  let responseDelay = 0;
  let listRequests = 0;
  const savedSelections = [];
  const pendingResponses = new Set();
  const failures = [];
  process.on('unhandledRejection', error => failures.push(error));
  const frontendJs = await fs.readFile(path.join(temp, 'frontend.js'));
  const backend = createServer((req, res) => {
    if (req.url === '/frontend.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(frontendJs);
    } else if (req.url === '/api/sandbox/config/select/list') {
      listRequests++;
      const data = {
        sandboxes: [{ sandboxId: '-1', name: '云端电脑', description: '' },
          ...(localAvailable ? [
            { sandboxId: '42', name: '本机电脑', description: '' },
            { sandboxId: '43', name: '另一台电脑', description: '' },
          ] : [])],
        agentSelected: { 7: '42' },
      };
      pendingResponses.add(res);
      const timer = setTimeout(() => {
        pendingResponses.delete(res);
        if (!res.destroyed) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: '0000', data }));
        }
      }, responseDelay);
      res.once('close', () => { clearTimeout(timer); pendingResponses.delete(res); });
    } else if (req.url === '/fixture/selection') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        savedSelections.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: '0000' }));
      });
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/frontend.js"></script></body></html>');
    }
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${backend.address().port}`;
  const { createComputerServiceStateBridge } = require(path.join(temp, 'state-bridge.cjs'));
  let state = { type: 'computer-service-state', phase: 'starting', sandboxId: '42' };
  // Production bridge uses these callbacks to project only the current state.
  const stateBridge = createComputerServiceStateBridge({
    getState: () => state,
    canSend: contents => {
      try { return contents.session === session.defaultSession && new URL(contents.getURL()).origin === origin; }
      catch { return false; }
    },
  });
  let host;
  let guest;
  const waitFor = async (predicate, label, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    do {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail(`timed out waiting for ${label}`);
  };
  try {
    ipcMain.on('nuwax:computer-service-state-sync', event => stateBridge.sync(event.sender));
    host = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    host.webContents.on('will-attach-webview', (_event, preferences) => {
      preferences.preload = path.join(temp, 'preload.cjs');
      preferences.contextIsolation = true;
      preferences.sandbox = true;
      preferences.nodeIntegration = false;
      preferences.backgroundThrottling = false;
      preferences.additionalArguments = [
        '--nuwax-host-product=nuwax',
        `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify([origin]))}`,
      ];
    });
    host.webContents.on('did-attach-webview', (_event, contents) => {
      guest = contents;
      stateBridge.attach(contents);
      contents.on('console-message', event => {
        if (event.level === 'error' || event.level === 3) failures.push(new Error(event.message));
      });
    });
    await fs.writeFile(path.join(temp, 'host.html'), '<!doctype html><html><body></body></html>');
    await host.loadFile(path.join(temp, 'host.html'));
    await host.webContents.executeJavaScript(`const wv=document.createElement('webview'); wv.style.cssText='width:800px;height:600px'; wv.src=${JSON.stringify(origin)}; document.body.append(wv);`);
    await waitFor(() => guest && guest.executeJavaScript('typeof window.fixtureMount === "function"'), 'guest source bundle');

    // State arrives before the app registers its single centralized listener.
    await guest.executeJavaScript('window.fixtureMount()');
    await waitFor(() => listRequests >= 1, 'initial list request');
    await waitFor(() => guest.executeJavaScript('document.body.textContent.includes("云端电脑")'), 'initial cloud-only selector');
    assert.equal((await guest.executeJavaScript('window.fixtureState()')).phase, 'starting');
    assert.equal(savedSelections.length, 0, 'transient cloud-only list must not persist -1');

    const beforeReady = listRequests;
    state = { type: 'computer-service-state', phase: 'ready', sandboxId: '42' };
    stateBridge.broadcast();
    await waitFor(() => listRequests > beforeReady, 'ready-triggered list refresh');
    // The backend has not yet propagated the local online computer at ready.
    localAvailable = true;
    await waitFor(() => guest.executeJavaScript('window.fixtureValue === "42"'), 'bounded retry restores remembered local computer');
    console.log('PASS initial-cloud -> lifecycle-ready -> delayed local candidate -> remembered selection');

    const beforeOpen = listRequests;
    responseDelay = 400;
    await guest.executeJavaScript('document.querySelector(".computer-selector").click()');
    await waitFor(() => listRequests > beforeOpen, 'dropdown-open refresh');
    await waitFor(() => guest.executeJavaScript('Array.from(document.querySelectorAll(".ant-dropdown-menu-item")).some(e=>e.textContent.includes("另一台电脑"))'), 'fresh candidate menu');
    await guest.executeJavaScript('Array.from(document.querySelectorAll(".ant-dropdown-menu-item")).find(e=>e.textContent.includes("另一台电脑")).click()');
    await waitFor(() => guest.executeJavaScript('window.fixtureValue === "43"'), 'manual choice');
    await waitFor(() => savedSelections.some(item => item.sandboxId === '43'), 'manual choice persistence');
    await waitFor(() => pendingResponses.size === 0, 'old dropdown request settles');
    assert.equal(await guest.executeJavaScript('window.fixtureValue'), '43', 'old server memory must not override manual choice');
    assert(savedSelections.every(item => item.sandboxId !== '-1'));
    console.log('PASS dropdown-open refresh preserves manual choice against old server memory');

    // A new document must receive a snapshot even when no state edge occurs.
    guest.reload();
    await waitFor(() => guest.executeJavaScript('typeof window.fixtureMount === "function" && window.fixtureValue === undefined').catch(() => false), 'guest reload');
    await guest.executeJavaScript('window.fixtureMount()');
    await waitFor(() => guest.executeJavaScript('window.fixtureState()?.phase === "ready"'), 'ready snapshot after document reload');
    console.log('PASS reloaded guest receives ready snapshot and preload late-subscription replay');
    await guest.executeJavaScript('window.fixtureUnmount()');
    assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'));
    console.log('PASS real Electron computer-list refresh acceptance');
  } finally {
    host?.destroy();
    for (const res of pendingResponses) res.destroy();
    await new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); });
  }
}

if (!process.env[fixtureEnvironment]) {
  launch().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app } = require('electron');
  run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
