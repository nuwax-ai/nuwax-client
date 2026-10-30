/** Real Electron compatibility check for the adapted upstream WebContentsView. */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const client = path.resolve(
  __dirname,
  "../../nuwa-electron-shell/crates/agent-electron-client",
);
if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-browser-check-"));
  try {
    require(path.join(client, "node_modules/esbuild")).buildSync({
      entryPoints: {
        pageView: path.join(
          client,
          "src/main/features/browser/vendor/pageView.ts",
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
      {
        env,
        stdio: "inherit",
        timeout: process.env.NUWAX_BROWSER_SHOW ? 180000 : 45000,
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, session, clipboard, Menu } = require("electron");
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
          `<title>${req.url}</title><p>Browser compatibility ${req.url}</p>`,
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
          `window.open(${JSON.stringify(origin + "/child")}); void 0`,
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
            "utf8",
          ),
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
          "did-finish-load",
        );
        await managed.contents.loadURL(origin + "/toolbar-page");
        await toolbarReady;
        const command = (cmd) =>
          managed.window.webContents.executeJavaScript(
            `window.browserWindow.command(${JSON.stringify(cmd)})`,
          );
        const getState = () =>
          managed.window.webContents.executeJavaScript(
            "window.browserWindow.getState()",
          );
        const waitFor = async (condition) => {
          const deadline = Date.now() + 5000;
          while (!(await condition())) {
            assert.ok(Date.now() < deadline, "browser state did not settle");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };
        const click = async (id) => {
          const point = await managed.window.webContents
            .executeJavaScript(`(() => {
            const el = document.getElementById(${JSON.stringify(id)});
            const rect = el.getBoundingClientRect();
            if (!rect.width || !rect.height) throw new Error('Control is hidden');
            return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
          })()`);
          for (const type of ["mouseDown", "mouseUp"])
            managed.window.webContents.sendInputEvent({
              type,
              ...point,
              button: "left",
              clickCount: 1,
            });
        };
        const bounds = () =>
          managed.window.contentView.children
            .find((view) => view.webContents === managed.contents)
            .getBounds();
        assert.equal((await getState()).url, origin + "/toolbar-page");
        assert.equal(
          await managed.contents.executeJavaScript(
            "typeof window.browserWindow",
          ),
          "undefined",
        );
        // Native page views sit above the local renderer: URL UI must reserve
        // real view bounds instead of opening an obscured modal/backdrop.
        await managed.contents.loadURL(origin + "/toolbar-next");
        await click("location");
        await waitFor(async () => (await getState()).addressOpen);
        assert.equal(bounds().y, 94);
        assert.equal(
          await managed.window.webContents.executeJavaScript(
            "document.querySelector(':modal') === null",
          ),
          true,
        );
        await click("back");
        await waitFor(
          () => managed.contents.getURL() === origin + "/toolbar-page",
        );
        await waitFor(async () => !(await getState()).loading);
        await click("forward");
        await waitFor(
          () => managed.contents.getURL() === origin + "/toolbar-next",
        );
        await waitFor(async () => !(await getState()).loading);
        let copied, menu;
        const writeText = clipboard.writeText;
        const buildMenu = Menu.buildFromTemplate;
        try {
          // Exercise real renderer input/IPC without changing the user's clipboard
          // or leaving a blocking native menu in an unattended run.
          clipboard.writeText = (text) => {
            copied = text;
          };
          Menu.buildFromTemplate = (template) => ({
            popup: () => {
              menu = template;
            },
          });
          await click("copyLink");
          await waitFor(() => copied === origin + "/toolbar-next");
          await click("menu");
          await waitFor(() => menu);
          assert.equal(
            menu.some((item) => item.label === messages["Claw.Browser.copy"]),
            false,
          );
        } finally {
          clipboard.writeText = writeText;
          Menu.buildFromTemplate = buildMenu;
        }
        await click("closeAddress");
        await waitFor(async () => !(await getState()).addressOpen);
        assert.equal(bounds().y, 52);
        await click("location");
        await waitFor(async () => (await getState()).addressOpen);
        managed.window.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "Escape",
        });
        await waitFor(async () => !(await getState()).addressOpen);
        // Check right-hand control layout at the supported minimum width on
        // both non-mac render paths; native OS behavior still needs OS testing.
        const state = await getState();
        managed.window.setSize(800, 600);
        for (const platform of ["win32", "linux"]) {
          managed.window.webContents.send("browser-window:changed", {
            ...state,
            platform,
          });
          await waitFor(() =>
            managed.window.webContents.executeJavaScript(
              `document.body.dataset.platform === ${JSON.stringify(platform)}`,
            ),
          );
          assert.equal(
            await managed.window.webContents.executeJavaScript(`(() => {
            const controls = document.getElementById('windowControls').getBoundingClientRect();
            const menu = document.getElementById('menu').getBoundingClientRect();
            return controls.width === 138 && controls.right === innerWidth && menu.right <= controls.left;
          })()`),
            true,
          );
        }
        managed.window.setSize(1100, 740);
        await getState();
        await command({ type: "zoom-in" });
        assert.equal((await getState()).zoom, 110);
        await command({ type: "zoom-reset" });
        assert.equal((await getState()).zoom, 100);
        await command({ type: "pin" });
        assert.equal(managed.window.isAlwaysOnTop(), true);
        await command({ type: "pin" });
        assert.equal(managed.window.isAlwaysOnTop(), false);
        await command({ type: "find-open" });
        await command({ type: "address-open" });
        assert.equal(bounds().y, 136);
        await command({ type: "address-close" });
        assert.equal(bounds().y, 94);
        const found = once(managed.contents, "found-in-page");
        await command({ type: "find", text: "Browser" });
        await found;
        assert.equal((await getState()).matches, 1);
        await command({ type: "find-close" });
        assert.equal(bounds().y, 52);
        assert.equal(await command({ type: "unknown" }), false);
        if (process.env.NUWAX_BROWSER_SCREENSHOT)
          fs.writeFileSync(
            process.env.NUWAX_BROWSER_SCREENSHOT,
            (await managed.window.capturePage()).toPNG(),
          );
        if (process.env.NUWAX_BROWSER_SHOW) {
          managed.window.show();
          managed.window.focus();
          console.log(
            JSON.stringify({
              inspection: true,
              pid: process.pid,
              title: managed.window.getTitle(),
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 120000));
        }
        await managed.contents.executeJavaScript(
          "window.onbeforeunload = () => false; void 0",
        );
        const prevented = once(managed.contents, "will-prevent-unload");
        await command({ type: "window-close" });
        await prevented;
        assert.equal(managed.window.isDestroyed(), false);
        await managed.contents.executeJavaScript(
          "window.onbeforeunload = null",
        );
        const gone = once(managed.contents, "destroyed");
        await command({ type: "window-close" });
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
              "URL row + mouse navigation/copy/menu + Escape",
              "Windows/Linux toolbar layout at 800px (renderer only)",
              "find",
              "close preserves beforeunload cancellation",
              "close",
            ],
          }),
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
