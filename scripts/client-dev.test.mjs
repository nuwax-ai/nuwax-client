import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertPortAvailable, waitForHttp, launch, stopProcess, developmentEnv, superviseElectron, DEV_RESTART_EXIT_CODE } from './client/dev.mjs';
import { unsignedEnv } from './client/pack.mjs';

test('all development modes isolate the profile while keeping the commercial host and automatic ports', () => {
  for (const mode of ['dist', 'source', 'remote']) {
    const env = developmentEnv('/client', mode, 3000);
    assert.equal(env.NUWAX_DEV_PROFILE, '1');
    assert.equal(env.NUWAX_DEV_SUPERVISED, '1');
    assert.equal(env.NUWAX_APP_IDENTIFIER, 'nuwax');
    assert.equal(env.NUWAX_LOCAL_PORT_MODE, 'auto');
    assert.equal(env.NUWAX_WEBVIEW_ORIGIN, mode === 'source' ? 'http://localhost:3000' : '');
  }
});

test('supervisor restarts Electron without stopping Vite and ends on normal quit', async () => {
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const viteExit = deferred();
  const firstExit = deferred();
  const secondExit = deferred();
  const vite = { exit: viteExit.promise, alive: () => true };
  const first = { exit: firstExit.promise };
  const second = { exit: secondExit.promise };
  let starts = 0;
  const disposed = [];
  const running = superviseElectron({ startElectron: () => [first, second][starts++], services: [vite], shouldStop: () => false, disposeElectron: async item => disposed.push(item) });
  firstExit.resolve({ code: DEV_RESTART_EXIT_CODE });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.deepEqual(disposed, [first]);
  secondExit.resolve({ code: 0 });
  const result = await running;
  assert.equal(result.electron, second);
  assert.equal(result.result.code, 0);
});

test('supervisor does not restart after Vite exits during Electron cleanup', async () => {
  let finishCleanup;
  let viteAlive = true;
  let starts = 0;
  const vite = { exit: new Promise(() => {}), alive: () => viteAlive };
  const electron = { exit: Promise.resolve({ code: DEV_RESTART_EXIT_CODE }) };
  const running = superviseElectron({ startElectron: () => { starts++; return electron; }, services: [vite], shouldStop: () => false, disposeElectron: () => new Promise(resolve => { finishCleanup = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  viteAlive = false;
  finishCleanup();
  await running;
  assert.equal(starts, 1);
});

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
