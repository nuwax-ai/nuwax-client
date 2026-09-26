/** Real Electron webview source fixture, isolated profile and loopback only.
 * Run: node scripts/acceptance/webview-load-recovery.cjs
 * This tests the host component against real navigation/crash events; it is not
 * an installer, production authentication, or the original #2537 incident.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");

async function launch() {
  const root = path.resolve(__dirname, "../..");
  const shell = path.join(
    root,
    "nuwa-electron-shell/crates/agent-electron-client"
  );
  const fromShell = createRequire(path.join(shell, "package.json"));
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "nuwax-webview-recovery-")
  );
  const component = path.join(
    shell,
    "src/renderer/components/pages/NuwaxHostWebview.tsx"
  );
  await fromShell("esbuild").build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Host from ${JSON.stringify(
        component
      )}; createRoot(document.getElementById('root')).render(React.createElement(Host));`,
      resolveDir: shell,
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    outfile: path.join(temp, "host.js"),
    nodePaths: [path.join(shell, "node_modules")],
    define: {
      "import.meta.env.DEV": "true",
      "process.env.NODE_ENV": '"development"',
    },
    plugins: [
      {
        name: "fixture-services",
        setup(build) {
          build.onResolve(
            {
              filter:
                /^(?:@shared\/constants|.*services\/(?:core\/(?:auth|i18n)|utils\/(?:sessionUrl|logService)))$/,
            },
            (args) => ({ path: args.path, namespace: "fixture" })
          );
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.includes("constants")
              ? 'export const APP_DISPLAY_NAME="Nuwax"; export const DEFAULT_SERVER_HOST="https://unused.example";'
              : args.path.includes("auth")
              ? "export const normalizeServerHost = s => s;"
              : args.path.includes("i18n")
              ? 'export const getCurrentLang = () => "zh-cn";'
              : args.path.includes("sessionUrl")
              ? "export const buildHomeUrl = s => s;"
              : "export const logger={info(){},error(...args){console.error(...args)}};",
          }));
        },
      },
    ],
  });
  await fs.writeFile(
    path.join(temp, "host.html"),
    '<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0;font-family:system-ui}</style><div id="root"></div><script src="host.js"></script>'
  );
  await fs.writeFile(
    path.join(temp, "preload.cjs"),
    `const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('electronAPI',{app:{getVersion:async()=>"fixture"},settings:{get:key=>ipcRenderer.invoke('fixture:settings',key)},on:(event,callback)=>ipcRenderer.on(event,callback),off:(event,callback)=>ipcRenderer.removeListener(event,callback)});`
  );
  const env = { ...process.env, NUWAX_RECOVERY_FIXTURE: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(fromShell("electron"), [__filename], {
    env,
    stdio: "inherit",
  });
  const watchdog = setTimeout(() => child.kill("SIGTERM"), 60000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  clearTimeout(watchdog);
  console.log(`FIXTURE_ARTIFACTS ${temp}`);
  process.exitCode = code;
}

async function run() {
  const { app, BrowserWindow, ipcMain, webContents } = require("electron");
  const temp = process.env.NUWAX_RECOVERY_FIXTURE;
  app.setPath("userData", path.join(temp, "profile"));
  app.commandLine.appendSwitch("no-proxy-server");
  let win;
  let server;
  const evidence = [];
  const waitFor = async (check, label) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      try {
        const result = await check();
        if (result) return result;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timeout: ${label}`);
  };
  try {
    await app.whenReady();
    // Reserve and then close an ephemeral port: the first guest must fail.
    const reserve = createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    let origin = `http://127.0.0.1:${port}`;
    let rejectSettings = false;
    ipcMain.handle("fixture:settings", (_event, key) => {
      if (rejectSettings) throw new Error("Controlled settings failure");
      return key === "step1_config" ? { serverHost: origin } : null;
    });
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 650,
      webPreferences: {
        preload: path.join(temp, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
    });
    win.webContents.on("did-attach-webview", (_event, guest) => {
      guest.on("did-fail-load", (_event, code, _description, _url, main) =>
        evidence.push({ event: "did-fail-load", code, main })
      );
      guest.on("render-process-gone", (_event, details) =>
        evidence.push({ event: "render-process-gone", reason: details.reason })
      );
    });
    await win.loadFile(path.join(temp, "host.html"));
    const host = (script) => win.webContents.executeJavaScript(script);
    const failed = () =>
      host(
        'Boolean(document.querySelector("[data-testid=guest-load-failure]"))'
      );
    await waitFor(failed, "main document failure panel");
    assert.ok(
      evidence.some(
        (e) => e.event === "did-fail-load" && e.main && e.code === -102
      )
    );
    await fs.writeFile(
      path.join(temp, "load-failure.png"),
      (await win.webContents.capturePage()).toPNG()
    );
    const firstId = await host(
      'document.querySelector("webview").getWebContentsId()'
    );
    server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<h1 id="success">Recovery fixture loaded</h1><iframe src="http://127.0.0.1:1/iframe"></iframe>'
      );
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const clickRetry = () =>
      host(
        'document.querySelector("[data-testid=guest-load-failure] button").click()'
      );
    const currentGuest = async () =>
      webContents.fromId(
        await host('document.querySelector("webview").getWebContentsId()')
      );
    await clickRetry();
    await waitFor(
      async () =>
        (
          await currentGuest()
        )?.executeJavaScript('Boolean(document.querySelector("#success"))'),
      "retry loads main document"
    );
    const secondId = await host(
      'document.querySelector("webview").getWebContentsId()'
    );
    assert.notEqual(secondId, firstId);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      await failed(),
      false,
      "subframe failure must not show main error panel"
    );
    evidence.push({
      check: "network failure + real button retry + iframe failure isolation",
      passed: true,
    });
    (await currentGuest()).forcefullyCrashRenderer();
    await waitFor(failed, "crashed guest recovery panel");
    await fs.writeFile(
      path.join(temp, "renderer-crash.png"),
      (await win.webContents.capturePage()).toPNG()
    );
    await clickRetry();
    await waitFor(
      async () =>
        (
          await currentGuest()
        )?.executeJavaScript('Boolean(document.querySelector("#success"))'),
      "crashed guest remount"
    );
    assert.notEqual(
      await host('document.querySelector("webview").getWebContentsId()'),
      secondId
    );
    assert.equal(await failed(), false);
    evidence.push({
      check: "real renderer crash + button remount",
      passed: true,
    });
    rejectSettings = true;
    win.webContents.send("nuwax:loopback-changed");
    await waitFor(failed, "URL resolution failure panel");
    rejectSettings = false;
    await clickRetry();
    await waitFor(
      async () =>
        (
          await currentGuest()
        )?.executeJavaScript('Boolean(document.querySelector("#success"))'),
      "settings failure recovery"
    );
    evidence.push({
      check: "configuration read failure + retry",
      passed: true,
    });
    await fs.writeFile(
      path.join(temp, "recovered.png"),
      (await win.webContents.capturePage()).toPNG()
    );
    await fs.writeFile(
      path.join(temp, "evidence.json"),
      JSON.stringify(
        {
          electron: process.versions.electron,
          platform: process.platform,
          evidence,
        },
        null,
        2
      )
    );
    console.log("WEBVIEW_LOAD_RECOVERY_FIXTURE_OK");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await fs.writeFile(
      path.join(temp, "evidence.json"),
      JSON.stringify({ error: String(error), evidence }, null, 2)
    );
    app.exit(1);
  } finally {
    server?.close();
    win?.destroy();
  }
}
if (process.env.NUWAX_RECOVERY_FIXTURE) run();
else
  launch().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
