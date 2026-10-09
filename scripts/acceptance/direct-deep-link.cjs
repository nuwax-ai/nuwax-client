/** 真实 Electron 隔离验收：旧服务端业务路径返回独立应用，客户端先加载主站。
 * Run: node scripts/acceptance/direct-deep-link.cjs
 * 使用实际商业请求策略及完整 preload；React Router 是 Umi 使用的路由机制。
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");

async function launch() {
  const root = path.resolve(__dirname, "../..");
  const shell = path.join(root, "nuwa-electron-shell/crates/agent-electron-client");
  const fromShell = createRequire(path.join(shell, "package.json"));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-direct-route-"));
  const source = path.join(root, "overlay/crates/agent-electron-client/src");
  const build = fromShell("esbuild").build;
  const common = { bundle: true, platform: "node", format: "cjs", external: ["electron"], alias: { "@shared": path.join(source, "shared") }, nodePaths: [path.join(shell, "node_modules")] };
  await build({ ...common, entryPoints: [path.join(source, "main/services/businessRequestRouting.ts")], outfile: path.join(temp, "routing.cjs") });
  await build({ ...common, entryPoints: [path.join(source, "preload/webviewPerfBridge.ts")], outfile: path.join(temp, "webviewPerfBridge.js"), define: { "process.env.NUWAX_APP_IDENTIFIER": '"nuwax"' } });
  const pnpm = path.join(root, "nuwax/node_modules/.pnpm");
  const router = (await fs.readdir(pnpm)).find((name) => name.startsWith("react-router-dom@6."));
  assert.ok(router, "frontend React Router dependency must be installed");
  await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserRouter,useLocation,useNavigate} from 'react-router-dom';
      function Main(){const location=useLocation();const navigate=useNavigate();window.fixtureNavigate=navigate;return React.createElement('main',{'data-route':location.pathname+location.search+location.hash},React.createElement('aside',{'data-testid':'sidebar'},'主站导航'),React.createElement('section',{},location.pathname));}
      createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,{},React.createElement(Main)));`, resolveDir: shell, loader: "tsx" },
    bundle: true, platform: "browser", outfile: path.join(temp, "fixture.js"),
    alias: { react: path.dirname(fromShell.resolve("react/package.json")), "react-dom": path.dirname(fromShell.resolve("react-dom/package.json")) },
    nodePaths: [path.join(shell, "node_modules"), path.join(pnpm, router, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const component = path.join(shell, "src/renderer/components/pages/NuwaxHostWebview.tsx");
  await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Host from ${JSON.stringify(component)};
      function Shell(){const ref=React.useRef();window.hostNavigate=url=>ref.current.navigate(url);return React.createElement(React.Fragment,{},React.createElement('button',{'data-testid':'reload',onClick:()=>ref.current.reload()},'刷新'),React.createElement(Host,{ref}));}
      createRoot(document.getElementById('root')).render(React.createElement(Shell));`, resolveDir: shell, loader: "tsx" },
    bundle: true, platform: "browser", outfile: path.join(temp, "host.js"), nodePaths: [path.join(shell, "node_modules")],
    define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "fixture-host-services", setup(build) {
      build.onResolve({ filter: /^(?:@shared\/constants|.*services\/(?:core\/(?:auth|i18n)|utils\/(?:sessionUrl|logService)))$/ }, args => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents:
        args.path.includes("constants") ? 'export const APP_DISPLAY_NAME="Nuwax";export const DEFAULT_SERVER_HOST="https://unused.example";' :
        args.path.includes("auth") ? "export const normalizeServerHost=s=>s;" :
        args.path.includes("i18n") ? 'export const getCurrentLang=()=>"zh-cn";' :
        args.path.includes("sessionUrl") ? "export const buildHomeUrl=s=>s+'/home';" :
        "export const logger={info(){},error(){}};" }));
    } }],
  });
  await fs.writeFile(path.join(temp, "host.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="host.css"><div id="root"></div><script src="host.js"></script>');
  await fs.writeFile(path.join(temp, "host-preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',{app:{getVersion:async()=>"fixture"},settings:{get:key=>ipcRenderer.invoke('fixture:settings',key)},on:(event,callback)=>ipcRenderer.on(event,callback),off:(event,callback)=>ipcRenderer.removeListener(event,callback)});`);
  const env = { ...process.env, NUWAX_DIRECT_FIXTURE: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(fromShell("electron"), [__filename], { env, stdio: "inherit" });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 90000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
  clearTimeout(watchdog);
  console.log(`FIXTURE_ARTIFACTS ${temp}`);
  if (timedOut) console.error("DIRECT_DEEP_LINK_FIXTURE_TIMEOUT");
  process.exitCode = timedOut ? 1 : code;
}

async function run() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const temp = process.env.NUWAX_DIRECT_FIXTURE;
  app.setPath("userData", path.join(temp, "profile"));
  app.commandLine.appendSwitch("no-proxy-server");
  const windows = [];
  const requests = [];
  const checks = [];
  let server;
  let foreign;
  let gateway;
  let failHome = false;
  let delayHomeNext = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, label) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      try { const result = await check(); if (result) return result; } catch {}
      await sleep(50);
    }
    throw new Error(`Timeout: ${label}`);
  };
  try {
    await app.whenReady();
    server = createServer(async (req, res) => {
      const pathname = new URL(req.url, "http://fixture.local").pathname;
      requests.push({ url: req.url, dest: req.headers["sec-fetch-dest"], method: req.method });
      res.setHeader("content-type", "text/html");
      if (pathname === "/fixture.js") {
        res.setHeader("content-type", "application/javascript");
        res.end(await fs.readFile(path.join(temp, "fixture.js"))); return;
      }
      if (pathname === "/home") {
        if (failHome) { res.destroy(); return; }
        const delay = delayHomeNext; delayHomeNext = 0;
        if (delay) await sleep(delay);
        res.end(`<!doctype html><meta charset="utf-8"><div id="root"></div><script>
          window.firstScript=location.pathname+location.search+location.hash;window.bootId=performance.timeOrigin;
          if(location.search.includes('needsLogin=1')&&!document.cookie.includes('fixtureLogin=1'))location.replace('/login?redirect='+encodeURIComponent(window.firstScript));
          </script><script src="/fixture.js"></script>`); return;
      }
      if (pathname === "/login") {
        res.end(`<button id="login" onclick="document.cookie='fixtureLogin=1;path=/';location.assign(new URLSearchParams(location.search).get('redirect'))">登录</button>`); return;
      }
      res.end('<h1 id="legacy">独立子应用，无主站导航</h1>');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { WebSocketServer } = require("ws");
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket, req) => {
      requests.push({ url: req.url, dest: "websocket", method: req.method });
      socket.send("direct websocket"); socket.close();
    });
    foreign = createServer((_req, res) => res.end('<h1 id="foreign">第三方</h1>'));
    await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
    gateway = createServer((req, res) => {
      requests.push({ url: req.url, dest: "gateway", method: req.method });
      res.setHeader("content-type", "text/html");
      res.end('<h1 id="gateway">网关文档</h1><script>window.gatewayRoute=location.pathname+location.search+location.hash</script>');
    });
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayOrigin = `http://127.0.0.1:${gateway.address().port}`;
    let directOrigin = origin;
    let mainHost = null;
    const routing = require(path.join(temp, "routing.cjs"));
    routing.initBusinessRequestRouting(() => directOrigin, () => mainHost);
    const preload = process.env.NUWAX_FIXTURE_PRELOAD || path.join(temp, "webviewPerfBridge.js");
    const prefs = { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--nuwax-host-product=nuwax", `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify([origin]))}`] };
    const mainPrefs = { ...prefs, additionalArguments: [...prefs.additionalArguments, "--nuwax-spa-document-restore=1"] };
    const makeWindow = () => {
      const win = new BrowserWindow({ show: false, webPreferences: prefs }); windows.push(win);
      win.webContents.on("console-message", (event) => { if (event.level === "error") console.error("PAGE_CONSOLE", event.message); });
      win.webContents.on("preload-error", (_event, _file, error) => console.error("PRELOAD_ERROR", error));
      return win;
    };
    const read = (contents, code, gesture = false) => contents.executeJavaScript(code, gesture);
    const expectRoute = (contents, target, first = true) => waitFor(async () => {
      const data = await read(contents, "({route:document.querySelector('main')?.dataset.route,sidebar:!!document.querySelector('[data-testid=sidebar]'),first:window.firstScript,href:location.href})");
      return data.sidebar && data.route === target && (!first || data.first === target) && !data.href.includes("__nuwax_spa_restore=") && data;
    }, `route ${target}`);
    const load = async (contents, target) => { await contents.loadURL(origin + target); return expectRoute(contents, target); };
    const win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, contextIsolation: true } }); windows.push(win);
    mainHost = win.webContents;
    let wc;
    win.webContents.on("will-attach-webview", (_event, preferences) => Object.assign(preferences, mainPrefs));
    win.webContents.on("did-attach-webview", (_event, contents) => { wc = contents; });
    await win.loadURL("data:text/html,<html><body></body></html>");
    const initialTarget = "/repo/doc/initial?q=%25#initial";
    await read(win.webContents, `const view=document.createElement('webview');view.setAttribute('allowpopups','');view.src=${JSON.stringify(origin + initialTarget)};document.body.append(view)`);
    await waitFor(() => wc, "main host guest"); await expectRoute(wc, initialTarget);
    checks.push("主窗口真实 webview 初次 src 深链，首脚本及 hash 恢复");
    await load(wc, "/home");
    const target = "/repo/doc/a?encoded=%252F&percent=%25&_shell=1#title%20a";
    await read(wc, `window.fixtureNavigate(${JSON.stringify(target)})`, true);
    await expectRoute(wc, target, false);
    const count = wc.navigationHistory.getAllEntries().length;
    const oldBoot = await read(wc, "window.bootId");
    wc.reload();
    await waitFor(() => read(wc, `window.bootId!==${oldBoot}`), "reload commits new document");
    await expectRoute(wc, target);
    assert.equal(wc.navigationHistory.getAllEntries().length, count);
    checks.push("SPA 进入后整页刷新：首脚本、React Router、侧栏、编码/hash、历史条目");
    assert.ok(!requests.some((r) => r.dest === "document" && r.url.startsWith("/repo")));
    const shortcutBoot = await read(wc, "window.bootId");
    wc.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key.toLowerCase() === "r" && (input.control || input.meta)) { event.preventDefault(); wc.reload(); }
    });
    wc.sendInputEvent({ type: "keyDown", keyCode: "R", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await waitFor(() => read(wc, `window.bootId!==${shortcutBoot}`), "real reload key");
    await expectRoute(wc, target); checks.push("真实 Ctrl/Cmd+R 输入");
    await load(wc, "/instant-message/conversation/7?view=detail#message-9");
    await load(wc, "/repo/"); checks.push("loadURL 消息深链及资料库尾斜杠");
    await read(wc, `location.assign('/repo/doc/search?query=%2525#match')`);
    await expectRoute(wc, "/repo/doc/search?query=%2525#match"); checks.push("location.assign 搜索兜底");
    await read(wc, "window.fixtureNavigate('/repo/doc/next')", true); await expectRoute(wc, "/repo/doc/next", false);
    wc.navigationHistory.goBack(); await expectRoute(wc, "/repo/doc/search?query=%2525#match", false);
    wc.navigationHistory.goForward(); await expectRoute(wc, "/repo/doc/next", false);
    await load(wc, "/home"); wc.navigationHistory.goBack(); await expectRoute(wc, "/repo/doc/next", false);
    assert.ok(wc.navigationHistory.getAllEntries().every((entry) => !entry.url.includes("__nuwax_spa_restore=")));
    checks.push("前进后退含跨文档恢复：历史 URL 无中间标记");
    const other = makeWindow();
    const standaloneTarget = "/instant-message/conversation/2?_shell=1#two";
    await Promise.all([load(wc, "/repo/doc/main-window#one"), other.loadURL(origin + standaloneTarget)]);
    assert.ok(await read(other.webContents, "!!document.querySelector('#legacy')&&!document.querySelector('[data-testid=sidebar]')"));
    assert.equal(other.webContents.getURL(), origin + standaloneTarget);
    await new Promise((resolve) => { other.webContents.once("did-finish-load", resolve); other.reload(); });
    assert.ok(await read(other.webContents, "!!document.querySelector('#legacy')"));
    assert.equal(other.webContents.getURL(), origin + standaloneTarget);
    const manualMarker = "/home#__nuwax_spa_restore=%2Frepo%2Fdoc%2Fstandalone";
    await other.loadURL(origin + manualMarker);
    assert.equal(await read(other.webContents, "location.pathname+location.hash"), manualMarker);
    checks.push("独立窗口深链、刷新和私有标记保持原行为；不串入主窗口路由");
    wc.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { show: false, webPreferences: prefs } }));
    let popup;
    wc.once("did-create-window", created => { windows.push(created); popup = created; });
    const popupTarget = "/repo/doc/popup?view=1#popup";
    await read(wc, `void window.open(${JSON.stringify(origin + popupTarget)})`, true);
    await waitFor(() => popup, "window.open creates popup");
    await waitFor(() => read(popup.webContents, "!!document.querySelector('#legacy')"), "standalone window.open");
    assert.equal(popup.webContents.getURL(), origin + popupTarget);
    checks.push("真实 window.open 新开窗口不接管");
    const beforeRace = requests.length;
    delayHomeNext = 500;
    const aborted = wc.loadURL(origin + "/repo/doc/race#old").catch(() => {});
    await waitFor(() => requests.length > beforeRace, "old navigation request started");
    await load(wc, "/repo/doc/race#new"); await aborted;
    await expectRoute(wc, "/repo/doc/race#new");
    checks.push("相同 pathname 快速导航取消旧请求，当前 hash 保持隔离");
    await wc.loadURL(origin + "/repo/doc/login?needsLogin=1#after-login");
    await waitFor(() => read(wc, "!!document.querySelector('#login')"), "login page");
    await read(wc, "document.querySelector('#login').click()");
    await expectRoute(wc, "/repo/doc/login?needsLogin=1#after-login"); checks.push("未登录整页进入、登录回跳");
    await read(wc, "document.body.insertAdjacentHTML('beforeend','<iframe src=\"/repo/doc/iframe\"></iframe>')");
    await waitFor(() => read(wc, "!!document.querySelector('iframe')?.contentDocument?.querySelector('#legacy')"), "legacy iframe");
    assert.ok(requests.some((r) => r.url === "/repo/doc/iframe" && r.dest === "iframe"));
    await read(wc, "Promise.all(['/repo/internal/session','/repo/ws','/repo/assets/a.js','/instant-message/ws'].map(path=>fetch(path)))");
    for (const target of ["/repo/internal/session", "/repo/ws", "/repo/assets/a.js", "/instant-message/ws"]) assert.ok(requests.some((r) => r.url === target));
    assert.equal(await read(wc, `new Promise((resolve,reject)=>{const ws=new WebSocket(${JSON.stringify(origin.replace("http:", "ws:") + "/repo/ws?check=direct")});ws.onmessage=event=>resolve(event.data);ws.onerror=reject})`), "direct websocket");
    assert.ok(requests.some((r) => r.url === "/repo/ws?check=direct" && r.dest === "websocket"));
    await read(wc, "fetch('/repo/doc/post',{method:'POST',body:'fixture'})");
    assert.ok(requests.some((r) => r.url === "/repo/doc/post" && r.method === "POST"));
    checks.push("iframe、API、真实 WebSocket、资源、POST 请求不接管");
    await wc.loadURL(foreignOrigin + "/repo/doc/third-party");
    assert.ok(await read(wc, "!!document.querySelector('#foreign')"));
    await wc.loadURL(foreignOrigin + "/home#__nuwax_spa_restore=%2Frepo%2Fdoc%2Fforeign");
    assert.equal(await read(wc, "location.pathname+location.hash"), "/home#__nuwax_spa_restore=%2Frepo%2Fdoc%2Fforeign");
    checks.push("第三方 origin 不接管");
    const host = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, contextIsolation: true } }); windows.push(host);
    let guest;
    host.webContents.on("will-attach-webview", (_event, preferences) => Object.assign(preferences, prefs));
    host.webContents.on("did-attach-webview", (_event, contents) => { guest = contents; });
    await host.loadURL("data:text/html,<html><body></body></html>");
    await read(host.webContents, `const view=document.createElement('webview');view.src=${JSON.stringify(origin + "/repo/doc/guest?q=%25#guest")};document.body.append(view)`);
    await waitFor(() => guest, "attach auxiliary guest");
    await waitFor(() => read(guest, "!!document.querySelector('#legacy')"), "auxiliary guest standalone document");
    await new Promise((resolve) => { guest.once("did-finish-load", resolve); guest.reload(); });
    assert.ok(await read(guest, "!!document.querySelector('#legacy')"));
    assert.equal(guest.getURL(), origin + "/repo/doc/guest?q=%25#guest");
    checks.push("其他窗口内的 webview 初次 src 和刷新不接管");
    ipcMain.handle("fixture:settings", (_event, key) => key === "step1_config" ? { serverHost: origin, nuwaxLoadMode: "direct" } : null);
    const shellWindow = new BrowserWindow({ show: false, webPreferences: { preload: path.join(temp, "host-preload.cjs"), webviewTag: true, contextIsolation: true } }); windows.push(shellWindow);
    mainHost = shellWindow.webContents;
    let shellGuest;
    shellWindow.webContents.on("will-attach-webview", (_event, preferences) => Object.assign(preferences, mainPrefs));
    shellWindow.webContents.on("did-attach-webview", (_event, contents) => { shellGuest = contents; });
    await shellWindow.loadFile(path.join(temp, "host.html"));
    await waitFor(() => shellGuest, "actual host component guest"); await expectRoute(shellGuest, "/home");
    const buttonTarget = "/repo/doc/button?view=%252F#section";
    await read(shellWindow.webContents, `window.hostNavigate(${JSON.stringify(origin + buttonTarget)})`);
    await expectRoute(shellGuest, buttonTarget);
    const buttonBoot = await read(shellGuest, "window.bootId");
    await read(shellWindow.webContents, "document.querySelector('[data-testid=reload]').click()");
    await waitFor(() => read(shellGuest, `window.bootId!==${buttonBoot}`), "actual host refresh handle"); await expectRoute(shellGuest, buttonTarget);
    checks.push("实际 NuwaxHostWebview 程序导航及刷新按钮调用 reload handle");
    mainHost = win.webContents;
    const hostPlain = new BrowserWindow({ show: false, webPreferences: { sandbox: true } }); windows.push(hostPlain);
    await hostPlain.loadURL(origin + "/repo/doc/host");
    assert.ok(await read(hostPlain.webContents, "!!document.querySelector('#legacy')"));
    checks.push("未配置业务 preload 的宿主窗口不接管");
    failHome = true;
    await wc.loadURL(origin + "/repo/doc/fail#retry").then(() => { throw new Error("expected main entry failure"); }, () => {});
    assert.ok(!requests.some((r) => r.dest === "document" && r.url === "/repo/doc/fail"));
    failHome = false;
    await load(wc, "/repo/doc/fail#retry"); checks.push("主站失败不退回独立应用、原深链重试");
    routing.setGatewayRequestRouting({ gatewayOrigin, backendOrigin: origin, backendPrefixes: ["/api", "/repo", "/instant-message"] });
    await wc.loadURL(gatewayOrigin + "/home");
    await read(wc, `location.assign(${JSON.stringify(origin + "/repo/doc/gateway?view=1#anchor")})`);
    await waitFor(() => read(wc, "window.gatewayRoute==='/repo/doc/gateway?view=1#anchor'&&!!document.querySelector('#gateway')"), "gateway document routing");
    assert.equal(wc.getURL(), gatewayOrigin + "/repo/doc/gateway?view=1#anchor");
    routing.setGatewayRequestRouting(null);
    await load(wc, "/repo/doc/direct-again#anchor");
    checks.push("gateway 原有文档归一及切回 direct，共用监听器");
    directOrigin = null;
    await wc.loadURL(origin + "/repo/doc/disabled");
    assert.ok(await read(wc, "!!document.querySelector('#legacy')"));
    checks.push("模式禁用立即生效");
    await fs.writeFile(path.join(temp, "evidence.json"), JSON.stringify({ electron: process.versions.electron, platform: process.platform, preload, checks, requests }, null, 2));
    console.log(`DIRECT_DEEP_LINK_FIXTURE_OK ${checks.length} checks`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    const pages = await Promise.all(windows.filter((win) => !win.isDestroyed()).map(async (win) => ({
      url: win.webContents.getURL(), history: win.webContents.navigationHistory.getAllEntries(),
      page: await win.webContents.executeJavaScript("({href:location.href,first:window.firstScript,route:document.querySelector('main')?.dataset.route})").catch(() => null),
    })));
    await fs.writeFile(path.join(temp, "evidence.json"), JSON.stringify({ error: String(error), checks, requests, pages }, null, 2));
    app.exit(1);
  } finally { server?.close(); foreign?.close(); gateway?.close(); windows.forEach((win) => { if (!win.isDestroyed()) win.destroy(); }); }
}
if (process.env.NUWAX_DIRECT_FIXTURE) run();
else launch().catch((error) => { console.error(error); process.exitCode = 1; });
