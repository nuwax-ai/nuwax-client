/** Exercise the client's certificate confirmation with real Chromium and local TLS. */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const client = path.resolve(__dirname, "../../nuwa-electron-shell/crates/agent-electron-client");

if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-certificate-check-"));
  try {
    for (const name of ["first", "changed"]) {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-keyout", path.join(dir, `${name}-key.pem`),
        "-out", path.join(dir, `${name}-cert.pem`),
      ], { stdio: "ignore" });
    }
    require(path.join(client, "node_modules/esbuild")).buildSync({
      entryPoints: {
        windows: path.join(client, "src/main/features/browser/windows.ts"),
        headers: path.join(client, "src/main/services/frameEmbeddingPolicy.ts"),
      },
      outdir: dir,
      outExtension: { ".js": ".cjs" },
      bundle: true, platform: "node", external: ["electron"],
      alias: { "@shared": path.join(client, "src/shared") },
    });
    fs.writeFileSync(path.join(dir, "toolbar.html"), "<!doctype html><title>Certificate check</title>");
    fs.writeFileSync(path.join(dir, "preload.cjs"), "");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // Reuse the profile and certificate to verify that a process restart clears trust.
    for (const run of ["first", "restart"]) {
      execFileSync(require(path.join(client, "node_modules/electron")), [__filename, dir, run], {
        env, stdio: "inherit", timeout: 45000,
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, dialog, session } = require("electron");
  const https = require("node:https");
  const { once } = require("node:events");
  const assert = require("node:assert/strict");
  const dir = process.argv[2];
  app.setPath("userData", path.join(dir, "profile"));
  app.whenReady().then(async () => {
    const { createBrowserWindows } = require(path.join(dir, "windows.cjs"));
    const { initFrameEmbeddingPolicy } = require(path.join(dir, "headers.cjs"));
    initFrameEmbeddingPolicy({ app, defaultSession: session.defaultSession, isCommercial: true, isDev: false });
    const { pathToFileURL } = require("node:url");
    const messages = JSON.parse(fs.readFileSync(path.join(client, "src/shared/locales/zh-CN.json"), "utf8"));
    const makeServer = async (name) => {
      const server = https.createServer({
        key: fs.readFileSync(path.join(dir, `${name}-key.pem`)),
        cert: fs.readFileSync(path.join(dir, `${name}-cert.pem`)),
      }, (req, res) => {
        if (["/app.js", "/dependency.js", "/page.css"].includes(req.url) && !req.headers.cookie?.includes("fixture_entry=allowed")) {
          res.setHeader("content-type", "text/html");
          res.end("<title>Security entry rejected</title>");
        } else if (req.url === "/app.js") {
          res.setHeader("content-type", "application/javascript");
          res.end("import { text } from '/dependency.js'; const form=document.querySelector('#loaded'); form.textContent=text; form.style.display='block';");
        } else if (req.url === "/dependency.js") {
          res.setHeader("content-type", "application/javascript");
          res.end("export const text='Certificate fixture loaded';");
        } else if (req.url === "/page.css") {
          res.setHeader("content-type", "text/css");
          res.end("body { background:#444 } #loaded { display:none }");
        } else {
          res.setHeader("content-type", "text/html");
          res.setHeader("set-cookie", "fixture_entry=allowed; HttpOnly; Path=/");
          res.setHeader("x-frame-options", "SAMEORIGIN");
          res.end("<title>Certificate fixture</title><link rel='stylesheet' href='/page.css'><script type='module' crossorigin src='/app.js'></script><p id='loaded'>Waiting for JavaScript</p>");
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server;
    };
    const server = await makeServer("first");
    const changedServer = await makeServer("changed");
    const url = `https://127.0.0.1:${server.address().port}/`;
    const prompts = [];
    const responses = [];
    let subresourceCertificateChallenges = 0;
    dialog.showMessageBox = async (_window, options) => {
      prompts.push(options);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.match(options.detail, /https:\/\/(127\.0\.0\.1|localhost):\d+/);
      assert.deepEqual(options.buttons, [messages["Claw.Browser.certificateCancel"], messages["Claw.Browser.certificateContinue"]]);
      assert.ok(responses.length, "unexpected certificate confirmation");
      return { response: responses.shift(), checkboxChecked: false };
    };
    const controller = createBrowserWindows({
      windows: { getMain: () => null },
      settings: { read: () => "light" },
      translate: (key) => messages[key],
      log: console,
    });
    const makePage = (ses = session.defaultSession) => {
      const page = controller.open({
        windowOptions: { show: false, webPreferences: { session: ses, sandbox: true } },
        toolbarUrl: pathToFileURL(path.join(dir, "toolbar.html")).href,
        preloadPath: path.join(dir, "preload.cjs"),
      });
      page.window.show = () => {}; // Keep the automated fixture off the user's desktop.
      page.contents.on("certificate-error", (_event, _target, _error, _certificate, _callback, main) => {
        if (!main) subresourceCertificateChallenges++;
      });
      return page;
    };
    const pageVisible = (page) => page.window.contentView.children
      .find((view) => view.webContents === page.contents).getVisible();
    try {
      const first = makePage();
      responses.push(0);
      await assert.rejects(first.contents.loadURL(url), /ERR_CERT_AUTHORITY_INVALID/);
      assert.equal(prompts.length, 1, "cancel must prompt and keep TLS enforcement");
      assert.equal(pageVisible(first), false, "cancel must keep the remote page hidden");
      responses.push(1);
      await first.contents.loadURL(url);
      assert.equal(await first.contents.executeJavaScript("document.querySelector('#loaded').textContent"), "Certificate fixture loaded");
      assert.equal(await first.contents.executeJavaScript("getComputedStyle(document.querySelector('#loaded')).display"), "block", "same-origin module dependencies must render the initially hidden login form");
      assert.equal(pageVisible(first), true, "consent must restore the browser's remote page");
      assert.equal(prompts.length, 2, "retry must request explicit consent");
      await first.contents.loadURL(url + "again");
      assert.equal(prompts.length, 2, "same window and certificate may reuse consent");

      const second = makePage();
      await second.contents.loadURL(url);
      assert.equal(prompts.length, 2, "same-session host/certificate trust matches the warning's stated scope");

      const separate = makePage(session.fromPartition("certificate-isolation"));
      responses.push(0);
      await assert.rejects(separate.contents.loadURL(url), /ERR_CERT_AUTHORITY_INVALID/);
      assert.equal(prompts.length, 3, "another session must still verify");

      responses.push(0);
      await assert.rejects(second.contents.loadURL(url.replace("127.0.0.1", "localhost")), /ERR_CERT_AUTHORITY_INVALID/);
      assert.equal(prompts.length, 4, "another host must ask even with the same certificate");

      responses.push(0);
      await assert.rejects(second.contents.loadURL(`https://127.0.0.1:${changedServer.address().port}/`), /ERR_CERT_AUTHORITY_INVALID/);
      assert.equal(prompts.length, 5, "a different certificate on the same host must ask");

      const unmanaged = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition("unmanaged"), sandbox: true } });
      await assert.rejects(unmanaged.loadURL(url), /ERR_CERT_AUTHORITY_INVALID/);
      assert.equal(prompts.length, 5, "unmanaged sessions must keep normal verification");
      console.log(JSON.stringify({ passed: true, run: process.argv[3], electron: process.versions.electron, subresourceCertificateChallenges, checks: [
        "client browser window wiring", "real self-signed TLS event", "cancel denies", "continue loads and reveals document", "same-site reuse",
        "cookie-gated module and imports reveal hidden form after response header rewriting",
        "shared-session scope disclosed", "other session/host/certificate isolation", "restart clears trust",
      ] }));
    } finally {
      controller.dispose();
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      server.close();
      server.closeAllConnections();
      changedServer.close();
      changedServer.closeAllConnections();
      app.quit();
    }
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
