import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertPortAvailable, waitForHttp, launch, stopProcess, developmentEnv, dev } from './client/dev.mjs';
import { prepareDevelopmentFrontend } from './client/dev-frontend.mjs';
import * as core from './client/core.mjs';
import { unsignedEnv } from './client/pack.mjs';

test('all development modes isolate the profile while keeping the commercial host and automatic ports', () => {
  for (const mode of ['dist', 'source', 'remote']) {
    const env = developmentEnv('/client', mode, mode === 'source' ? '/private-preview/dist' : undefined);
    assert.equal(env.NUWAX_DEV_PROFILE, '1');
    assert.equal(env.NUWAX_APP_IDENTIFIER, 'nuwax');
    assert.equal(env.NUWAX_LOCAL_PORT_MODE, 'auto');
    assert.equal(env.NUWAX_WEBVIEW_ORIGIN, '');
    assert.equal(env.NUWAX_DEV_FRONTEND_MODE, mode);
    assert.equal(env.NUWAX_FRONTEND_DIST, mode === 'source' ? '/private-preview/dist' : '/client/nuwax-dist');
  }
});

test('source preview launches only the local shell and Electron with the private production frontend', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-dev-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = core.paths(root);
  const binary = path.join(root, 'electron-fixture');
  const vite = path.join(p.client, 'node_modules/vite/bin/vite.js');
  for (const file of [binary, vite]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
  const launched = [], waited = [], checkedPorts = [];
  let disposed = false;
  await dev(root, {
    frontend: 'source', port: 3000,
    tools: { ...core, npmRun: async () => {} },
    prepare: async () => ({}),
    prepareDevelopmentApp: async () => ({ binary }),
    prepareDevelopmentFrontend: async () => ({ distDir: '/private-source/dist', dispose: () => { disposed = true; } }),
    assertPortAvailable: async (port) => { checkedPorts.push(port); },
    waitForHttp: async (url) => { waited.push(url); },
    launch: (command, args, options) => {
      launched.push({ command, args, ...options });
      return { child: {}, alive: () => true, exit: options.name === 'vite' ? new Promise(() => {}) : Promise.resolve({ code: 0 }) };
    },
  });
  assert.deepEqual(launched.map(item => item.name), ['vite', 'electron', 'computer-use-prepare']);
  assert.deepEqual(checkedPorts, [61173], 'the PC Web development port is never claimed');
  assert.equal(waited.length, 1);
  assert.ok(waited[0].includes(':61173/'));
  assert.ok(launched.every(item => item.env.NUWAX_WEBVIEW_ORIGIN === ''));
  assert.ok(launched.every(item => item.env.NUWAX_FRONTEND_DIST === '/private-source/dist'));
  assert.equal(disposed, true);
});

for (const fail of [false, true]) {
  test(`source preview restores developer dist after ${fail ? 'failed' : 'successful'} production build`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-dev-dist-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dist = path.join(root, 'nuwax/dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'developer-wip.txt'), 'preserve these bytes');
    let built;
    const run = () => prepareDevelopmentFrontend(root, { buildFrontend: async (_root, options) => {
      assert.equal(options.cleanDist, false);
      assert.equal(fs.existsSync(dist), false);
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, 'index.html'), 'local production preview');
      if (fail) throw new Error('build rejected');
      return { distDir: dist, sourceSha: 'fixture' };
    } });
    if (fail) await assert.rejects(run(), /build rejected/);
    else {
      built = await run();
      assert.equal(fs.readFileSync(path.join(built.distDir, 'index.html'), 'utf8'), 'local production preview');
    }
    assert.deepEqual(fs.readdirSync(dist), ['developer-wip.txt']);
    assert.equal(fs.readFileSync(path.join(dist, 'developer-wip.txt'), 'utf8'), 'preserve these bytes');
    built?.dispose();
    assert.deepEqual(fs.readdirSync(path.join(core.paths(root).cache, 'dev')), []);
  });
}

test('packaging cannot inherit the local development profile', () => {
  const previous = process.env.NUWAX_DEV_PROFILE;
  try {
    process.env.NUWAX_DEV_PROFILE = '1';
    assert.equal(unsignedEnv('/client').NUWAX_DEV_PROFILE, '');
  } finally {
    if (previous === undefined) delete process.env.NUWAX_DEV_PROFILE;
    else process.env.NUWAX_DEV_PROFILE = previous;
  }
});

test('occupied ports are reported without killing existing service', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(assertPortAvailable(server.address().port), /不可用.*EADDRINUSE/);
  assert.ok(server.listening);
});

test('readiness waits for actual HTTP response and catches premature process exit', async (t) => {
  const server = http.createServer((request, response) => { response.writeHead(200); response.end('ready'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await waitForHttp(`http://127.0.0.1:${server.address().port}/`, { timeout: 1_000 });
  await assert.rejects(waitForHttp('http://127.0.0.1:1/', { alive: () => false }), /提前退出/);
  await assert.rejects(waitForHttp('http://127.0.0.1:1/', { timeout: 30, interval: 10 }), /超时/);
});

test('managed cleanup stops child process tree and releases its port', { skip: process.platform === 'win32' }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-dev-tree-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const descendant = "require('http').createServer((q,r)=>r.end('ready')).listen(0,'127.0.0.1',function(){console.log('READY '+this.address().port)})";
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const managed = launch(process.execPath, ['-e', parent], { cwd: directory, env: process.env, log: path.join(directory, 'dev.log'), name: 'fixture' });
  t.after(() => stopProcess(managed.child));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture failed to start')), 5_000);
    managed.child.stdout.on('data', (chunk) => {
      const match = /READY (\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  await waitForHttp(`http://127.0.0.1:${port}/`, { timeout: 1_000 });
  await stopProcess(managed.child);
  await managed.exit;
  await assertPortAvailable(port);
});
