import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function paths(root) {
  const base = path.join(root, 'nuwa-electron-shell');
  return { root, base, client: path.join(base, 'crates', 'agent-electron-client'),
    frontend: path.join(root, 'nuwax'), dist: path.join(root, 'nuwax-dist'),
    cache: path.join(root, '.cache', 'client-toolchain') };
}

export function run(command, args = [], options = {}) {
  const { cwd, env, capture = false, allowFailure = false, ...rest } = options;
  let executable = command;
  let argv = args.map(String);
  let shell = false;
  if (command === 'npm' && process.env.npm_execpath?.endsWith('.js')) {
    executable = process.execPath;
    argv = [process.env.npm_execpath, ...argv];
  } else if (process.platform === 'win32' && /^(npm|pnpm|corepack|npx)(\.cmd)?$/.test(command)) {
    executable = command.endsWith('.cmd') ? command : command + '.cmd';
    // These shims require cmd.exe. User Git refs always use git.exe without a shell.
    if (argv.some(value => /[&|<>^%\r\n]/.test(value))) {
      throw new Error('Package manager arguments contain unsupported shell characters');
    }
    argv = argv.map(value => '"' + value.replaceAll('"', '\\"') + '"');
    shell = true;
  }
  const result = spawnSync(executable, argv, {
    ...rest, cwd, env: env ? { ...process.env, ...env } : process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8', shell, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  const output = { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
  if (result.error) output.stderr ||= result.error.message;
  if (output.status !== 0 && !allowFailure) {
    throw new Error(command + ' failed (' + output.status + ')' + (output.stderr ? ': ' + output.stderr.trim() : ''));
  }
  return output;
}

export function git(dir, args, options = {}) {
  return run('git', ['-C', dir, ...args], { capture: true, ...options }).stdout.trim();
}
export function npmRun(dir, script, args = [], options = {}) {
  return run('npm', ['run', script, ...(args.length ? ['--', ...args] : [])], { cwd: dir, ...options });
}
export function pnpmRun(dir, args, options = {}) {
  if (run('corepack', ['--version'], { capture: true, allowFailure: true }).status === 0) {
    // Lifecycle scripts also invoke `pnpm`. Give them the same Corepack shim
    // without changing the developer's globally installed package manager.
    const shims = path.join(os.tmpdir(), 'nuwax-toolchain-corepack', fingerprint([process.execPath, process.version]).slice(0, 12));
    fs.mkdirSync(shims, { recursive: true });
    if (!fs.existsSync(path.join(shims, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'))) {
      run('corepack', ['enable', '--install-directory', shims, 'pnpm'], { capture: true });
    }
    const environment = { ...process.env, ...options.env };
    const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'PATH';
    environment[pathKey] = shims + path.delimiter + (environment[pathKey] || '');
    return run('corepack', ['pnpm', ...args], { ...options, cwd: dir, env: environment });
  }
  const spec = readJson(path.join(dir, 'package.json')).packageManager || '';
  const found = run('pnpm', ['--version'], { cwd: dir, capture: true, allowFailure: true });
  if (found.status !== 0 || (spec.startsWith('pnpm@') && found.stdout.trim() !== spec.slice(5).split('+')[0])) {
    throw new Error('Install/enable Corepack or ' + (spec || 'pnpm') + ' for ' + dir);
  }
  return run('pnpm', args, { cwd: dir, ...options });
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function fingerprint(values) {
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(temporary, file);
}
export function fileHash(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}
export async function withLock(root, name, task) {
  const lock = path.join(paths(root).cache, name + '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (fs.existsSync(lock)) {
    const previous = readJson(lock);
    let alive = previous.host !== os.hostname();
    try { process.kill(previous.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
    if (alive) throw new Error(name + ' is already running (pid ' + previous.pid + ')');
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  fs.closeSync(fd);
  try { return await task(); } finally { fs.rmSync(lock, { force: true }); }
}
