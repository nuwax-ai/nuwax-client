#!/usr/bin/env node
/** Local support snapshot. It exports log metadata, never log message bodies. */
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir, platform, release } from 'node:os';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--log-dir', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) {
    console.error('用法: node scripts/export-diagnostics.mjs [--log-dir DIR] [--output FILE]');
    process.exit(1);
  }
  options[args[i]] = args[i + 1];
}
const logDir = resolve(options['--log-dir'] ?? join(homedir(), '.nuwax', 'logs'));
const output = resolve(options['--output'] ?? `nuwax-diagnostics-${Date.now()}.json`);
if (!output || !logDir) {
  console.error('用法: node scripts/export-diagnostics.mjs [--log-dir DIR] [--output FILE]');
  process.exit(1);
}

function readLogTail(path) {
  const size = statSync(path).size;
  const length = Math.min(size, 2_000_000);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  let offset = 0;
  try {
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, size - length + offset);
      if (read === 0) break;
      offset += read;
    }
  }
  finally { closeSync(fd); }
  return buffer.subarray(0, offset).toString('utf8');
}

function git(...command) {
  try { return execFileSync('git', command, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

const ports = [19099, ...Array.from({ length: 8 }, (_, i) => 61002 + i), 61173];
const componentAllowlist = new Set([
  'AuthLifecycle', 'CommercialAuth', 'LoopbackGateway', 'FileServer',
  'Lanproxy', 'AutoUpdater', 'Sandbox', 'Electron',
]);
function listening(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(350);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => { socket.destroy(); done(false); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
  });
}

const summaries = [];
if (existsSync(logDir)) {
  for (const name of readdirSync(logDir).filter((n) => /^main\.\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort().slice(-3)) {
    const path = join(logDir, name);
    if (!statSync(path).isFile()) continue;
    const data = readLogTail(path);
    const levels = { error: 0, warn: 0, info: 0, debug: 0 };
    const components = {};
    const codes = {};
    for (const line of data.split('\n')) {
      const level = line.match(/\b(ERROR|WARN|INFO|DEBUG)\b/i)?.[1]?.toLowerCase();
      if (level && level in levels) levels[level]++;
      const component = line.match(/\[([A-Za-z][A-Za-z0-9]{1,35})\]/)?.[1];
      if (componentAllowlist.has(component)) components[component] = (components[component] ?? 0) + 1;
      for (const code of line.match(/\b(?:EPERM|EACCES|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOENT|EPIPE)\b/g) ?? []) {
        codes[code] = (codes[code] ?? 0) + 1;
      }
    }
    summaries.push({ file: basename(path), sampledBytes: Buffer.byteLength(data), levels, components, codes });
  }
}

const portChecks = await Promise.all(ports.map(async (port) => ({ port, listening: await listening(port) })));
const snapshot = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  host: { platform: platform(), release: release(), arch: process.arch },
  sourceCheckout: {
    client: git('rev-parse', 'HEAD'),
    shell: git('rev-parse', 'HEAD:nuwa-electron-shell'),
    frontend: git('rev-parse', 'HEAD:nuwax'),
  },
  logSummaries: summaries,
  // Port reachability is a clue, not proof of process ownership or health.
  localPortReachability: portChecks,
};
writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(`[diagnostics] 已保存 ${output}；只包含日志级别、组件和错误码统计，不包含原始日志正文`);
