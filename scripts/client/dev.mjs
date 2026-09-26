import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import config from '../../client.config.mjs';
import * as core from './core.mjs';
import { prepare, commercialEnv, electronBinary, fileReady } from './prepare.mjs';

export function assertPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(new Error(`[dev] ${host}:${port} 不可用 (${error.code})；请停止占用进程或修改端口配置`)));
    server.listen(port, host, () => server.close(resolve));
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function waitForHttp(url, { timeout = 180_000, alive = () => true, interval = 250 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!alive()) throw new Error(`[dev] 服务提前退出: ${url}`);
    const ready = await new Promise((resolve) => {
      const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode >= 200 && response.statusCode < 400); });
      request.setTimeout(1_000, () => request.destroy());
      request.on('error', () => resolve(false));
    });
    if (ready) return;
    await delay(interval);
  }
  throw new Error(`[dev] 等待服务超时: ${url}`);
}

export async function stopProcess(child, platform = process.platform) {
  if (!child?.pid) return;
  if (platform === 'win32') {
    // taskkill addresses only the process tree created by this invocation.
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
    return;
  }
  const signal = (name) => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  await delay(250);
  // A parent can exit while Electron helpers still belong to its process group.
  signal('SIGKILL');
}

export function launch(command, args, { cwd, env, log, name, platform = process.platform } = {}) {
  const output = fs.createWriteStream(log, { flags: 'a' });
  const child = spawn(command, args, { cwd, env, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let failure = null;
  child.on('error', (error) => { failure = error; console.error(`[dev:${name}] ${error.message}`); });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => { output.write(chunk); process.stdout.write(`[${name}] ${chunk}`); });
  const exit = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
  child.once('close', () => output.end());
  return { child, exit, alive: () => !failure && child.exitCode === null && child.signalCode === null };
}

/** Start independent frontend/Vite/Electron processes, retaining Vite's valid cache. */
export async function dev(root, options = {}) {
  const tools = options.tools ?? core;
  const p = tools.paths(root);
  const mode = options.frontend ?? 'dist';
  const frontendPort = options.frontendPort ?? options.port ?? config.frontend.port;
  const rendererPort = 60173 + Number(config.product.portOffset);
  const gatewayPort = config.frontend.gatewayPort ?? 46800;
  const prepared = await (options.prepare ?? prepare)(root, { ...options, frontend: mode });
  if (options.dryRun) {
    console.log(`[dev] dry-run: frontend=${mode}, Vite=${rendererPort}, gateway=${gatewayPort}${mode === 'source' ? `, HMR=${frontendPort}` : ''}`);
    return prepared;
  }
  for (const port of [rendererPort, gatewayPort, ...(mode === 'source' ? [frontendPort] : [])]) await assertPortAvailable(port);
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const env = commercialEnv(root, { NODE_ENV: 'development', ...(mode === 'source' ? { NUWAX_WEBVIEW_ORIGIN: `http://localhost:${frontendPort}` } : { NUWAX_WEBVIEW_ORIGIN: '' }) });
  const launchProcess = options.launch ?? launch;
  const processes = [];
  let stopping;
  let requestedSignal = null;
  const stop = async () => {
    stopping ??= Promise.all(processes.map(({ child }) => stopProcess(child)));
    await stopping;
  };
  const onInterrupt = () => { requestedSignal = 'SIGINT'; void stop(); };
  const onTerminate = () => { requestedSignal = 'SIGTERM'; void stop(); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const start = (name, command, args, cwd, processEnv = env) => {
    const log = path.join(logs, `${name}-dev.log`);
    fs.writeFileSync(log, `=== ${name} ${new Date().toISOString()} ===\n`);
    const item = launchProcess(command, args, { cwd, env: processEnv, log, name });
    processes.push(item);
    console.log(`[dev] ${name} 日志: ${log}`);
    return item;
  };
  const check = (file) => { if (!fileReady(file)) throw new Error(`[dev] 缺少执行入口 ${file}`); return file; };
  try {
    if (mode === 'source') {
      const frontend = start('frontend', process.execPath, [check(path.join(p.frontend, 'node_modules/@umijs/max/bin/max.js')), 'dev', '--port', String(frontendPort)], p.frontend, { ...env, UMI_ENV: 'development', PORT: String(frontendPort), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() });
      await waitForHttp(`http://127.0.0.1:${frontendPort}/`, { alive: frontend.alive });
    }
    const vite = start('vite', process.execPath, [check(path.join(p.client, 'node_modules/vite/bin/vite.js')), '--host', '127.0.0.1', '--port', String(rendererPort), '--strictPort'], p.client);
    await waitForHttp(`http://127.0.0.1:${rendererPort}/`, { alive: vite.alive });
    if (requestedSignal) return { ...prepared, stopped: true };
    await tools.npmRun(p.client, 'build:main:dev', [], { env });
    if (requestedSignal) return { ...prepared, stopped: true };
    const electron = start('electron', check(electronBinary(p.client)), ['.'], p.client);
    console.log(`[dev] Electron 已启动；前端 ${mode === 'source' ? `HMR http://localhost:${frontendPort}` : p.dist}。按 Ctrl+C 停止全部进程。`);
    const exits = processes.map((item) => item.exit.then((result) => ({ item, result })));
    const { result } = await Promise.race(exits);
    if (result.code !== 0 && !requestedSignal) throw new Error(`[dev] 子进程退出 (${result.code})；查看 ${logs}`);
    return { ...prepared, stopped: true, code: requestedSignal ? 0 : result.code, electronPid: electron.child.pid };
  } catch (error) {
    if (requestedSignal) return { ...prepared, stopped: true, code: 0 };
    throw error;
  } finally {
    await stop();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
