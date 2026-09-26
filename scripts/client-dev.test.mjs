import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertPortAvailable, waitForHttp, launch, stopProcess } from './client/dev.mjs';

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
