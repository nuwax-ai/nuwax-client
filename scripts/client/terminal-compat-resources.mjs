import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as core from './core.mjs';

export const terminalCompatLockFile = root => path.join(root, 'third-party/terminal-compat-sources.json');
export const terminalCompatDirectory = root => path.join(core.paths(root).client, 'resources/ttyd/legacy/win32-x64');
export const TERMINAL_COMPAT_FILES = ['ttyd-legacy.exe', 'winpty.dll', 'winpty-agent.exe', 'build.json'];

function sourceKey(root, tools) {
  const directory = path.join(root, 'native/legacy-terminal');
  const inputs = fs.readdirSync(directory).filter(name => /\.(?:go|mod|sum)$/.test(name)).sort();
  return tools.fingerprint([
    tools.fileHash(terminalCompatLockFile(root)),
    tools.fileHash(path.join(root, 'scripts/client/terminal-compat-resources.mjs')),
    ...inputs.map(name => [name, tools.fileHash(path.join(directory, name))]),
  ]);
}

export function inspectTerminalCompatResource(root, { platform = process.platform, arch = process.arch, tools = core } = {}) {
  if (platform !== 'win32') return null;
  if (arch !== 'x64') throw new Error('[terminal] Windows 10 1511 compatibility requires x64');
  const dir = terminalCompatDirectory(root);
  try {
    const lock = tools.readJson(terminalCompatLockFile(root));
    const state = tools.readJson(path.join(dir, 'build.json'));
    if (state.schema !== 1 || state.key !== sourceKey(root, tools)) return null;
    for (const [name, entry] of Object.entries(lock.files)) {
      if (tools.fileHash(path.join(dir, name)) !== entry.sha256) return null;
    }
    if (!/^[a-f0-9]{64}$/.test(state.executableSha256 ?? '') || tools.fileHash(path.join(dir, 'ttyd-legacy.exe')) !== state.executableSha256) return null;
    return { dir, state };
  } catch { return null; }
}

/** 检查 builder 真正拷入 unpacked 包的字节，阻止只准备资源却漏装入包。 */
export function verifyPackagedTerminalCompat(root, output, options = {}) {
  const opt = { platform: 'win32', arch: 'x64', tools: core, ...options };
  const expected = inspectTerminalCompatResource(root, opt);
  if (!expected) throw new Error('[terminal] Source compatibility resources are not admitted');
  const roots = [output, ...fs.readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(output, entry.name))];
  const candidates = roots.map(dir => path.join(dir, 'resources/ttyd/legacy/win32-x64')).filter(dir => fs.existsSync(dir));
  if (!candidates.length) throw new Error('[terminal] Windows unpacked package is missing compatibility resources');
  for (const dir of candidates) {
    for (const name of TERMINAL_COMPAT_FILES) {
      if (opt.tools.fileHash(path.join(dir, name)) !== opt.tools.fileHash(path.join(expected.dir, name))) {
        throw new Error(`[terminal] Packaged resource mismatch: ${name}`);
      }
    }
  }
  return candidates;
}

function verify(file, expected, tools) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || tools.fileHash(file) !== expected) {
    throw new Error(`[terminal] SHA256 mismatch: ${path.basename(file)}`);
  }
}

export async function prepareTerminalCompatResources(root, options = {}) {
  const opt = { tools: core, platform: process.platform, arch: process.arch, ...options };
  if (opt.platform !== 'win32') return null;
  if (opt.arch !== 'x64') throw new Error('[terminal] Windows 10 1511 compatibility requires x64');
  const { tools } = opt;
  return tools.withLock(root, 'terminal-compat', async () => {
    const cached = inspectTerminalCompatResource(root, opt);
    if (cached && !opt.refreshResources) return cached.dir;
    const lock = tools.readJson(terminalCompatLockFile(root));
    if (lock.schema !== 1 || !/^go1\.\d+\.\d+$/.test(lock.goToolchain)) throw new Error('[terminal] Invalid source lock');
    const cache = path.join(tools.paths(root).cache, 'terminal-compat');
    fs.mkdirSync(cache, { recursive: true });
    const archive = path.join(cache, lock.source.archive);
    if (!fs.existsSync(archive) || tools.fileHash(archive) !== lock.source.sha256) {
      const download = archive + `.${randomUUID()}.tmp`;
      try {
        await tools.run('curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '20', '--output', download, lock.source.url], { cwd: root });
        verify(download, lock.source.sha256, tools);
        fs.renameSync(download, archive);
      } finally { fs.rmSync(download, { force: true }); }
    }
    verify(archive, lock.source.sha256, tools);
    const staging = fs.mkdtempSync(path.join(cache, 'build-'));
    const output = path.join(staging, 'output');
    const unpack = path.join(staging, 'upstream');
    fs.mkdirSync(output);
    fs.mkdirSync(unpack);
    try {
      if (process.platform === 'win32') {
        const quote = value => "'" + value.replaceAll("'", "''") + "'";
        await tools.run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(unpack)} -Force`], { cwd: root });
      } else {
        await tools.run('unzip', ['-q', archive, '-d', unpack], { cwd: root });
      }
      verify(path.join(unpack, 'LICENSE'), lock.source.licenseSha256, tools);
      verify(path.join(root, 'third-party/licenses/winpty.txt'), lock.source.licenseSha256, tools);
      for (const [name, entry] of Object.entries(lock.files)) {
        const source = path.join(unpack, entry.archivePath);
        verify(source, entry.sha256, tools);
        fs.copyFileSync(source, path.join(output, name));
      }
      await tools.run('go', ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', path.join(output, 'ttyd-legacy.exe'), '.'], {
        cwd: path.join(root, 'native/legacy-terminal'),
        env: { GOOS: 'windows', GOARCH: 'amd64', GOAMD64: 'v1', CGO_ENABLED: '0', GOWORK: 'off', GOTOOLCHAIN: lock.goToolchain },
      });
      const executableSha256 = tools.fileHash(path.join(output, 'ttyd-legacy.exe'));
      if (!executableSha256) throw new Error('[terminal] Compatibility executable was not built');
      // 专用生成目录自行忽略产物，不改写基座的受跟踪 .gitignore。
      fs.writeFileSync(path.join(output, '.gitignore'), '*\n');
      tools.atomicJson(path.join(output, 'build.json'), { schema: 1, key: sourceKey(root, tools), goToolchain: lock.goToolchain, executableSha256 });
      const dir = terminalCompatDirectory(root);
      // 只替换工具链产物目录，不触碰兼容程序源码与开发者资源。
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(output, dir);
      if (!inspectTerminalCompatResource(root, opt)) throw new Error('[terminal] Built resources failed integrity verification');
      return dir;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
