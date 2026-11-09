import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const AGENT_DESKTOP_VERSION = '1.2.0';
export const AGENT_DESKTOP_INTEGRITY = 'sha512-sp8hHs8JfnuZe8ZQwiKZrqSOlu26SSeZXkjDog4KsU31L09G3uZJa8pITGN2vORif9uuh0iOSJHD146CEyTqag==';
const source = `https://registry.npmjs.org/agent-desktop/-/agent-desktop-${AGENT_DESKTOP_VERSION}.tgz`;
export function desktopResourceFiles(platform, arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Agent Desktop platform');
  return [`agent-desktop-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`,
    ...(platform === 'darwin' ? [`agent-desktop-macos-helper-darwin-${arch}`] : []),
    ...(platform === 'linux' ? [`agent-desktop-linux-clipboard-owner-linux-${arch}`] : [])];
}
export function verifyDesktopArchive(bytes) {
  if (bytes.length > 32 * 1024 * 1024 || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== AGENT_DESKTOP_INTEGRITY)
    throw new Error('Agent Desktop archive integrity mismatch');
}
export async function prepareAgentDesktop(root, { platform = process.platform, arch = process.env.TARGET_ARCH || process.arch, fetcher } = {}) {
  const files = desktopResourceFiles(platform, arch);
  const destination = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources/agent-desktop', `${platform}-${arch}`);
  const manifest = path.join(destination, 'source.json');
  try {
    const previous = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (previous.integrity === AGENT_DESKTOP_INTEGRITY && files.every(name =>
      fs.lstatSync(path.join(destination, name)).isFile() && !fs.lstatSync(path.join(destination, name)).isSymbolicLink() &&
      createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex') === previous.files[name])) return destination;
  } catch { /* Missing or changed payload is rebuilt from the pinned archive. */ }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-agent-desktop-'));
  try {
    const archive = path.join(stage, 'archive.tgz');
    if (fetcher) {
      const response = await fetcher(source);
      if (!response.ok || Number(response.headers.get('content-length')) > 32 * 1024 * 1024) throw new Error('Agent Desktop download failed');
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 32 * 1024 * 1024) throw new Error('Agent Desktop archive too large');
        chunks.push(chunk);
      }
      fs.writeFileSync(archive, Buffer.concat(chunks));
    } else {
      await exec('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2',
        '--connect-timeout', '20', '--max-time', '120', '--max-filesize', String(32 * 1024 * 1024), '--output', archive, source], { timeout: 180_000 });
    }
    verifyDesktopArchive(fs.readFileSync(archive));
    await exec('tar', ['-xzf', archive, '-C', stage, ...files.flatMap(name => [`package/bin/${name}`, `package/bin/${name}.sha256`])]);
    const payload = path.join(stage, 'payload'); fs.mkdirSync(payload);
    const hashes = {};
    for (const name of files) {
      const from = path.join(stage, 'package/bin', name);
      if (!fs.lstatSync(from).isFile() || fs.lstatSync(from).isSymbolicLink()) throw new Error('Agent Desktop payload is not a regular file');
      const hash = createHash('sha256').update(fs.readFileSync(from)).digest('hex');
      if (hash !== fs.readFileSync(from + '.sha256', 'utf8').trim()) throw new Error('Agent Desktop binary digest mismatch');
      hashes[name] = hash; fs.copyFileSync(from, path.join(payload, name)); fs.chmodSync(path.join(payload, name), 0o755);
    }
    fs.writeFileSync(path.join(payload, 'source.json'), JSON.stringify({ version: AGENT_DESKTOP_VERSION, source, integrity: AGENT_DESKTOP_INTEGRITY, files: hashes }, null, 2) + '\n');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true }); fs.cpSync(payload, destination, { recursive: true });
    return destination;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareAgentDesktop(fileURLToPath(new URL('../..', import.meta.url)));
}
