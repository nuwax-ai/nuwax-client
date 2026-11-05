import { cp, mkdir, readFile, readdir, rm, rename, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { botClientProfile } from '../../nuwa-electron-shell/crates/dsh-runtime/bot-client-profile.mjs';

export const DSH_VERSIONS = Object.freeze({ dsh: '0.2.1-rc.5', bot: '0.2.7', botSource: '71d344bf193f3f18185f25de3d8e5c483046910a' });
const targetNames = { 'win32-x64': 'win-x64', 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64' };
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('DSH dependency installation failed')));
});
export async function dshSourceDigest(source) {
  const hash = createHash('sha256');
  async function visit(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      if (['node_modules', 'test', '.cache'].includes(name)) continue;
      const file = path.join(dir, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) await visit(file, prefix + name + '/');
      else if (stat.isFile()) { hash.update(prefix + name); hash.update(await readFile(file)); }
    }
  }
  await visit(source);
  return hash.digest('hex');
}
/** Materialize target-specific dependencies, independently of existing native-helper caches. */
export async function prepareDshResources(root, options = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.env.TARGET_ARCH ?? process.arch;
  const target = targetNames[platform + '-' + arch];
  if (!target) throw new Error('Unsupported DSH runtime target');
  const source = path.join(root, 'nuwa-electron-shell/crates/dsh-runtime');
  const resources = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources');
  const output = path.join(resources, 'dsh-runtime');
  const digest = await dshSourceDigest(source);
  const key = digest + ':' + platform + ':' + arch;
  let marker;
  try { marker = JSON.parse(await readFile(path.join(output, 'nuwax-runtime.json'), 'utf8')); } catch { /* No prepared payload. */ }
  if (options.refreshResources || marker?.key !== key) {
    await mkdir(resources, { recursive: true });
    const staging = output + '.' + randomUUID();
    try {
      await cp(source, staging, { recursive: true, verbatimSymlinks: true,
        filter: file => !['node_modules', 'test'].includes(path.basename(file)) });
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--os=' + platform, '--cpu=' + arch], staging);
      const botClient = path.join(staging, 'node_modules/ds-bot/client.js');
      await writeFile(botClient, botClientProfile(await readFile(botClient, 'utf8')));
      await writeFile(path.join(staging, 'nuwax-runtime.json'), JSON.stringify({ key, platform, arch, ...DSH_VERSIONS }) + '\n');
      await rm(output, { recursive: true, force: true });
      await rename(staging, output);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const { preparePrimaryRuntime } = await import(pathToFileURL(path.join(output, 'vendor/prepare-office.mjs')).href);
  await preparePrimaryRuntime({ target, output: path.join(resources, 'dsh-office'),
    cache: options.cache ?? path.join(root, '.cache/dsh-office'),
    version: DSH_VERSIONS.bot,
    skillSource: path.join(output, 'node_modules/@deepseek-ai/dsh-skill-office/assets') });
  const office = path.join(resources, 'dsh-office');
  const licenses = [];
  async function collectLicenses(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await collectLicenses(file);
      else if (/^(LICENSE|COPYING|NOTICE)/i.test(entry.name) && entry.name !== 'LICENSES.txt') {
        licenses.push(path.relative(office, file) + '\n' + await readFile(file, 'utf8'));
      }
    }
  }
  await collectLicenses(office);
  if (!licenses.length) throw new Error('Office payload has no license evidence');
  await writeFile(path.join(office, 'LICENSES.txt'), licenses.join('\n\n'));
  return { runtime: output, office, key };
}
