/** Real Electron compatibility check for the adapted upstream WebContentsView. */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const client = path.resolve(
  __dirname,
  "../../nuwa-electron-shell/crates/agent-electron-client"
);
if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-browser-check-"));
  try {
    require(path.join(client, "node_modules/esbuild")).buildSync({
      entryPoints: {
        pageView: path.join(
          client,
          "src/main/features/browser/vendor/pageView.ts"
        ),
        windows: path.join(client, "src/main/features/browser/windows.ts"),
      },
      outdir: dir,
      outExtension: { ".js": ".cjs" },
      bundle: true,
      platform: "node",
      external: ["electron"],
      alias: { "@shared": path.join(client, "src/shared") },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    require("node:child_process").execFileSync(
      require(path.join(client, "node_modules/electron")),
      [__filename, dir],
      { env, stdio: "inherit", timeout: 45000 }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, session } = require("electron");
  const assert = require("node:assert/strict");
  const http = require("node:http");
  const { once } = require("node:events");
  const dir = process.argv[2];
  app.setPath("userData", path.join(dir, "profile"));
  app
    .whenReady()
    .then(async () => {
      const { PageView } = require(path.join(dir, "pageView.cjs"));
      const server = http.createServer((req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(
          `<title>${req.url}</title><p>Browser compatibility ${req.url}</p>`
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 720,
        webPreferences: { sandbox: true },
      });
      const page = new PageView(win, {
        webPreferences: {
          session: session.defaultSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      try {
        await page.webContents.loadURL(origin + "/first");
        await page.webContents.loadURL(origin + "/second");
        assert.equal(page.webContents.navigationHistory.canGoBack(), true);
        const back = once(page.webContents, "did-finish-load");
        page.webContents.navigationHistory.goBack();
        await back;
        assert.equal(page.webContents.getURL(), origin + "/first");
        const reload = once(page.webContents, "did-finish-load");
        page.webContents.reload();
        await reload;
        let child;
        page.webContents.setWindowOpenHandler(() => ({
          action: "allow",
          createWindow: (options) => {
            child = new PageView(win, {
              webContents: options.webContents,
              webPreferences: options.webPreferences,
            });
            return child.webContents;
          },
        }));
        const loaded = new Promise((resolve) => {
          const timer = setInterval(() => {
            if (
              child &&
              child.webContents.getURL() === origin + "/child" &&
              !child.webContents.isLoading()
            ) {
              clearInterval(timer);
              resolve();
            }
          }, 20);
        });
        await page.webContents.executeJavaScript(
          `window.open(${JSON.stringify(origin + "/child")}); void 0`
        );
        await loaded;
        assert.equal(child.webContents.opener !== null, true);
        const childGone = once(child.webContents, "destroyed");
        child.destroy();
        await childGone;
        const pageGone = once(page.webContents, "destroyed");
        page.destroy();
        await pageGone;
        const { createBrowserWindows } = require(path.join(dir, "windows.cjs"));
        const { pathToFileURL } = require("node:url");
        const messages = JSON.parse(
          fs.readFileSync(
            path.join(client, "src/shared/locales/zh-CN.json"),
            "utf8"
          )
        );
        const controller = createBrowserWindows({
          settings: { read: () => "light" },
          windows: { getMain: () => win },
          translate: (key) => messages[key],
          log: console,
        });
        const managed = controller.open({
          windowOptions: {
            width: 1100,
            height: 740,
            webPreferences: {
              session: session.defaultSession,
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
            },
          },
          toolbarUrl: pathToFileURL(path.join(client, "dist/browser.html"))
            .href,
          preloadPath: path.join(client, "dist/preload/browserWindow.js"),
        });
        if (!process.env.NUWAX_BROWSER_SHOW) managed.window.show = () => {};
        const toolbarReady = once(
          managed.window.webContents,
          "did-finish-load"
        );
        await managed.contents.loadURL(origin + "/toolbar-page");
        await toolbarReady;
        const command = (cmd) =>
          managed.window.webContents.executeJavaScript(
            `window.browserWindow.command(${JSON.stringify(cmd)})`
          );
        const getState = () =>
          managed.window.webContents.executeJavaScript(
            "window.browserWindow.getState()"
          );
        assert.equal((await getState()).url, origin + "/toolbar-page");
        assert.equal(
          await managed.contents.executeJavaScript(
            "typeof window.browserWindow"
          ),
          "undefined"
        );
        await command({ type: "zoom-in" });
        assert.equal((await getState()).zoom, 110);
        await command({ type: "zoom-reset" });
        assert.equal((await getState()).zoom, 100);
        await command({ type: "pin" });
        assert.equal(managed.window.isAlwaysOnTop(), true);
        await command({ type: "pin" });
        assert.equal(managed.window.isAlwaysOnTop(), false);
        await command({ type: "find-open" });
        const found = once(managed.contents, "found-in-page");
        await command({ type: "find", text: "Browser" });
        await found;
        assert.equal((await getState()).matches, 1);
        await command({ type: "find-close" });
        assert.equal(await command({ type: "unknown" }), false);
        if (process.env.NUWAX_BROWSER_SCREENSHOT)
          fs.writeFileSync(
            process.env.NUWAX_BROWSER_SCREENSHOT,
            (await managed.window.capturePage()).toPNG()
          );
        if (process.env.NUWAX_BROWSER_SHOW) {
          managed.window.show();
          managed.window.focus();
          console.log(
            JSON.stringify({
              inspection: true,
              pid: process.pid,
              title: managed.window.getTitle(),
            })
          );
          await new Promise((resolve) => setTimeout(resolve, 30000));
        }
        const gone = once(managed.contents, "destroyed");
        managed.window.close();
        await gone;
        controller.dispose();
        console.log(
          JSON.stringify({
            passed: true,
            electron: process.versions.electron,
            checks: [
              "load",
              "history",
              "reload",
              "popup guest adoption/opener",
              "dispose",
              "built toolbar/preload IPC",
              "remote page isolation",
              "zoom",
              "native pin",
              "find",
              "close",
            ],
          })
        );
      } finally {
        win.destroy();
        server.close();
        app.quit();
      }
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}
