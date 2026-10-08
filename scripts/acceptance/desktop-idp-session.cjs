/** 本地 IdP fixture + 临时 Electron profile；验证实际导航、preload 和 Cookie 镜像。
 * node scripts/acceptance/desktop-idp-session.cjs --frontend /path/to/nuwax
 * --shell-deps /path/to/installed/nuwa-electron-shell 可复用已有依赖，不修改该目录。
 * --baseline <Git ref> 只替换网关策略，对照不同网关策略；不预设真实网络事件一定触发归一。
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { spawn, execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const flag = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? null : process.argv[i + 1];
};
const fixtureEnv = "NUWAX_DESKTOP_IDP_FIXTURE";
const root = path.resolve(__dirname, "../..");
const services = path.join(
  root,
  "overlay/crates/agent-electron-client/src/main/services"
);

async function launch() {
  const frontend = path.resolve(flag("--frontend") || path.join(root, "nuwax"));
  const shell = path.resolve(
    flag("--shell-deps") || path.join(root, "nuwa-electron-shell")
  );
  const fromShell = createRequire(
    path.join(shell, "crates/agent-electron-client/package.json")
  );
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-desktop-idp-"));
  let child, watchdog;
  try {
    const build = fromShell("esbuild").build;
    const baseline = flag("--baseline");
    const policy = baseline
      ? execFileSync(
          "git",
          [
            "show",
            `${baseline}:overlay/crates/agent-electron-client/src/main/services/loopbackGateway/routingPolicy.ts`,
          ],
          { cwd: root, encoding: "utf8" }
        )
      : null;
    await build({
      stdin: {
        contents: `export * from ${JSON.stringify(
          path.join(services, "loopbackGateway/routingPolicy.ts")
        )};export * from ${JSON.stringify(
          path.join(services, "commercialTicketSession.ts")
        )};export * from ${JSON.stringify(
          path.join(services, "sessionAuthInjection.ts")
        )};export {settings} from '@fixture/db';`,
        resolveDir: root,
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: path.join(temp, "native.cjs"),
      external: ["electron"],
      plugins: [
        {
          name: "fixture-settings",
          setup(b) {
            b.onResolve(
              { filter: /^(electron-log|@shared\/constants|@fixture\/db)$/ },
              (a) => ({ path: a.path, namespace: "fixture" })
            );
            b.onResolve({ filter: /^(?:\.\.\/)+db$/ }, () => ({
              path: "@fixture/db",
              namespace: "fixture",
            }));
            b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
              loader: "js",
              contents:
                a.path === "electron-log"
                  ? "export default {info(){},warn(){},error(){},debug(){}}"
                  : a.path === "@shared/constants"
                  ? 'export const APP_NAME_IDENTIFIER="nuwax",DEFAULT_SERVER_HOST="https://unused.invalid";'
                  : "export const settings=new Map();export const readSetting=k=>settings.get(k)??null;export const writeSetting=(k,v)=>{settings.set(k,v);return true;};",
            }));
            if (policy)
              b.onLoad(
                { filter: /loopbackGateway\/routingPolicy\.ts$/ },
                () => ({
                  contents: policy,
                  loader: "ts",
                  resolveDir: path.join(services, "loopbackGateway"),
                })
              );
          },
        },
      ],
    });
    await build({
      entryPoints: [
        path.join(
          root,
          "overlay/crates/agent-electron-client/src/preload/webviewPerfBridge.ts"
        ),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: path.join(temp, "preload.cjs"),
      external: ["electron"],
      alias: {
        "@shared/types/computerServiceState": path.join(
          root,
          "overlay/crates/agent-electron-client/src/shared/types/computerServiceState.ts"
        ),
        "@shared/types/imReceiver": path.join(
          root,
          "overlay/crates/agent-electron-client/src/shared/types/imReceiver.ts"
        ),
        "@shared": path.join(
          root,
          "nuwa-electron-shell/crates/agent-electron-client/src/shared"
        ),
      },
      define: { "process.env.NUWAX_APP_IDENTIFIER": '"nuwax"' },
    });
    await build({
      stdin: {
        contents: `import {startIdpNavigation,completeDesktopIdpReturn} from ${JSON.stringify(
          path.join(frontend, "src/utils/idpNavigation.ts")
        )};window.startFixture=mode=>startIdpNavigation({providerId:7,mode,redirect:'/fixture-target?deep=1#section'});if(new URLSearchParams(location.search).has('desktopIdpReturn')||new URLSearchParams(location.search).has('idpError'))completeDesktopIdpReturn().then(r=>document.body.dataset.result=r);`,
        resolveDir: frontend,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: path.join(temp, "frontend.js"),
      alias: { "@": path.join(frontend, "src") },
      define: { "process.env.BASE_URL": '"https://wrong-build-time.invalid"' },
      plugins: [
        {
          name: "fixture-host-adapter",
          setup(b) {
            b.onResolve({ filter: /^\.\/hostBridge$/ }, (a) =>
              a.importer.endsWith("/idpNavigation.ts")
                ? { path: "host", namespace: "fixture" }
                : undefined
            );
            b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "js",
              contents:
                "export const hostBridge={host:{getProduct:()=>window.NuwaClawBridge?.host.getProduct()},auth:{getContext:()=>window.NuwaClawBridge.auth.getContext(),beginLogin:()=>window.NuwaClawBridge.auth.beginLogin(),syncSession:()=>window.NuwaClawBridge.auth.syncSession()}};",
            }));
          },
        },
      ],
    });
    const env = { ...process.env, [fixtureEnv]: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(fromShell("electron"), [__filename], {
      env,
      stdio: "inherit",
    });
    watchdog = setTimeout(() => child.kill("SIGKILL"), 55_000);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function run() {
  const {
    app,
    BrowserWindow,
    session,
    ipcMain,
    webContents,
  } = require("electron");
  const temp = process.env[fixtureEnv];
  app.setPath("userData", path.join(temp, "profile"));
  app.setPath("sessionData", path.join(temp, "profile"));
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const native = require(path.join(temp, "native.cjs"));
  const javascript = await fs.readFile(path.join(temp, "frontend.js"));
  const requests = [],
    returns = new Map();
  let business,
    gateway,
    provider,
    mode,
    loginNumber = 0;
  const serve = (role) =>
    createServer((req, res) => {
      const u = new URL(req.url, "http://fixture");
      const cookie = req.headers.cookie || "";
      requests.push({
        role,
        path: u.pathname,
        state: cookie.includes("idp_state=fixture"),
        ticket: cookie.includes("ticket=fixture-ticket"),
        capability: !!req.headers["x-nuwax-gateway-request"],
      });
      if (u.pathname === "/fixture.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end(javascript);
        return;
      }
      if (
        u.pathname === "/api/auth/idp/authorize" ||
        u.pathname === "/api/user/identity/bind/7"
      ) {
        const state = String(++loginNumber);
        returns.set(state, u.searchParams.get("redirect"));
        res.writeHead(302, {
          "Set-Cookie": "idp_state=fixture; HttpOnly; SameSite=Lax; Path=/",
          Location: `${provider}/provider?state=${state}`,
        });
        res.end();
        return;
      }
      if (u.pathname === "/provider") {
        res.end(
          `<title>Provider</title><a id="continue" href="${business}/api/auth/idp/callback?state=${u.searchParams.get(
            "state"
          )}">Continue</a>`
        );
        return;
      }
      if (u.pathname === "/api/auth/idp/callback") {
        if (!cookie.includes("idp_state=fixture")) {
          res.writeHead(400);
          res.end("STATE_COOKIE_MISSING");
          return;
        }
        if (u.searchParams.has("error")) {
          res.writeHead(302, {
            Location: `${business}/login?idpError=fixture_denied&redirect=${encodeURIComponent(
              returns.get(u.searchParams.get("state"))
            )}`,
          });
          res.end();
          return;
        }
        res.writeHead(302, {
          "Set-Cookie": "ticket=fixture-ticket; HttpOnly; SameSite=Lax; Path=/",
          Location: `${business}${returns.get(u.searchParams.get("state"))}`,
        });
        res.end();
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<title>Desktop IdP fixture</title><h1>Fixture</h1><script src="/fixture.js"></script>'
      );
    });
  const servers = [serve("business"), serve("gateway"), serve("provider")];
  for (const server of servers)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  business = `http://localhost:${servers[0].address().port}`;
  gateway = `http://127.0.0.1:${servers[1].address().port}`;
  provider = `http://127.0.0.1:${servers[2].address().port}`;
  native.settings.set("step1_config", { serverHost: business });
  const context = () => ({
    businessOrigin: business,
    gatewayOrigin: mode === "gateway" ? gateway : null,
    loadMode: mode,
  });
  native.initSessionAuthInjection(() => ({
    businessOrigin: business,
    trustedOrigins: [business, ...(mode === "gateway" ? [gateway] : [])],
    gateway:
      mode === "gateway"
        ? { origin: gateway, requestSecret: "fixture-secret" }
        : null,
  }));
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const wc = webContents.fromId(d.webContentsId);
    const target =
      mode === "gateway"
        ? native.normalizeGatewayRequestUrl(
            {
              url: d.url,
              resourceType: d.resourceType,
              webContentsUrl: wc?.getURL() || "",
              frameUrl: d.frame?.url,
              parentFrameUrl: d.frame?.parent?.url,
              referrer: d.referrer,
            },
            {
              backendOrigin: business,
              gatewayOrigin: gateway,
              backendPrefixes: ["/api"],
            }
          )
        : null;
    cb(target ? { redirectURL: target } : {});
  });
  const checkSender = (event) =>
    assert(
      [business, gateway].includes(new URL(event.senderFrame.url).origin),
      "IPC sender must be trusted"
    );
  ipcMain.handle("auth:getContext", (e) => {
    checkSender(e);
    return context();
  });
  ipcMain.handle("auth:beginLogin", async (e) => {
    checkSender(e);
    native.invalidateTicketSession([business, gateway]);
    await native.clearTicketCookies([business, gateway]);
    return true;
  });
  ipcMain.handle("auth:syncSession", async (e) => {
    checkSender(e);
    return native.syncTicketFromJar(business);
  });
  const wait = async (predicate, label) => {
    const until = Date.now() + 7000;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(
      `${label}; windows=${JSON.stringify(
        BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
      )}; last requests=${JSON.stringify(requests.slice(-5))}`
    );
  };
  try {
    for (mode of ["direct", "gateway"]) {
      await native.restoreTicketSession(mode === "gateway" ? gateway : null);
      for (const operation of ["login", "bind", "bind-error", "login-error"]) {
        const source = mode === "gateway" ? gateway : business;
        const mark = requests.length;
        const win = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            preload: path.join(temp, "preload.cjs"),
            additionalArguments: [
              "--nuwax-host-product=nuwax",
              `--nuwax-trusted-origins=${encodeURIComponent(
                JSON.stringify([business, gateway])
              )}`,
            ],
          },
        });
        await win.loadURL(`${source}/login?local=1`);
        await win.webContents.executeJavaScript(
          `window.startFixture(${JSON.stringify(
            operation.startsWith("bind") ? "bind" : "login"
          )});void 0;`
        );
        await wait(
          () =>
            win.webContents.getURL().startsWith(`${provider}/provider`) &&
            !win.webContents.isLoading(),
          `${mode}/${operation}: provider`
        );
        assert.equal(
          await win.webContents.executeJavaScript(
            "typeof window.NuwaClawBridge"
          ),
          "undefined",
          "external IdP gets no bridge"
        );
        assert(
          !requests
            .slice(mark)
            .find((r) => r.role === "provider" && (r.ticket || r.capability)),
          "external IdP gets no business credentials"
        );
        if (operation.endsWith("-error"))
          await win.webContents.executeJavaScript(
            'const a=document.getElementById("continue");a.href+="&error=1";void 0;'
          );
        await win.webContents.executeJavaScript(
          'document.getElementById("continue").click();void 0;'
        );
        const target =
          operation === "login-error"
            ? `${source}/login?${new URLSearchParams({
                local: "1",
                idpError: "fixture_denied",
                redirect: "/fixture-target?deep=1#section",
              })}`
            : operation === "bind-error"
            ? `${source}/fixture-target?deep=1&idpError=fixture_denied#section`
            : `${source}/fixture-target?deep=1#section`;
        await wait(
          () =>
            win.webContents.getURL() === target && !win.webContents.isLoading(),
          `${mode}/${operation}: target`
        );
        assert(
          requests
            .slice(mark)
            .find(
              (r) =>
                r.role === "business" &&
                r.path === "/api/auth/idp/callback" &&
                r.state
            ),
          "business callback has state cookie"
        );
        const ticket = (
          await session.defaultSession.cookies.get({
            url: source,
            name: "ticket",
          })
        )[0];
        if (operation === "login-error")
          assert(!ticket, "failed login must not restore a stale ticket");
        else
          assert(
            ticket?.value === "fixture-ticket" && ticket.httpOnly,
            "target has mirrored HttpOnly ticket"
          );
        assert.equal(
          await win.webContents.executeJavaScript(
            "typeof window.NuwaClawBridge"
          ),
          "object",
          "trusted return restores actual bridge"
        );
        win.destroy();
        console.log(
          `PASS ${mode}/${operation}: state Cookie, safe deep return, HttpOnly mirror, IdP isolation`
        );
      }
    }
  } finally {
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    for (const server of servers)
      await new Promise((resolve) => server.close(resolve));
    app.quit();
  }
}

(process.env[fixtureEnv] ? run() : launch()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  if (process.versions.electron) require("electron").app.exit(1);
});
