#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../client.config.mjs';
import * as core from './client/core.mjs';
import updater from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/app-update-config.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export function prepareReleaseUpdater(client, feedBase = config.product.feedBase) {
  const file = path.join(client, 'package.json');
  const pkg = core.readJson(file);
  if (pkg.build?.appId !== config.product.appId || pkg.build?.extraMetadata?.name !== config.product.identifier) {
    throw new Error('[app-update] Commercial application identity is required');
  }
  pkg.build = updater.configureUpdater(pkg.build, { feedBase });
  core.atomicJson(file, pkg);
}

export function verifyUpdaterApp(app, feedBase = config.product.feedBase) {
  return updater.verifyResources(path.join(app, 'Contents/Resources'), feedBase);
}

export function packagedResources(output, platform, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('[app-update] Unsupported architecture');
  if (platform === 'darwin') return path.join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Nuwax.app/Contents/Resources');
  if (platform === 'win32') return path.join(output, arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked', 'resources');
  if (platform === 'linux') return path.join(output, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'resources');
  throw new Error('[app-update] Unsupported platform');
}

/** Verify distribution bytes, never repair an already signed application. */
export async function verifyUpdaterOutput(output, {
  platform = process.platform, arch = process.arch, feedBase = config.product.feedBase,
  archives = true, tools = core,
} = {}) {
  updater.verifyResources(packagedResources(output, platform, arch), feedBase);
  if (platform !== 'darwin' || !archives) return;
  const files = fs.readdirSync(output);
  const zips = files.filter(name => name.endsWith('.zip'));
  const dmgs = files.filter(name => name.endsWith('.dmg'));
  if (!zips.length || !dmgs.length) throw new Error('[app-update] Expected macOS ZIP and DMG distributions');
  for (const zip of zips) {
    const result = await tools.run('unzip', ['-p', path.join(output, zip), 'Nuwax.app/Contents/Resources/app-update.yml'], { capture: true });
    if (!Buffer.from(result.stdout).equals(updater.configBytes(feedBase))) throw new Error(`[app-update] Missing or incorrect ZIP configuration: ${zip}`);
  }
  for (const dmg of dmgs) {
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-updater-dmg-'));
    let attached = false;
    try {
      await tools.run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(output, dmg)], { capture: true });
      attached = true;
      verifyUpdaterApp(path.join(mount, 'Nuwax.app'), feedBase);
    } finally {
      if (attached) await tools.run('hdiutil', ['detach', mount], { capture: true });
      fs.rmSync(mount, { recursive: true, force: true });
    }
  }
  console.log('[app-update] Verified unpacked app, ZIP and DMG update configuration');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
      const index = args.indexOf(name);
      if (index < 0) return fallback;
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
      return args[index + 1];
    };
    const output = option('--verify-output');
    const app = option('--verify-app');
    if (output) await verifyUpdaterOutput(output, { arch: option('--arch', process.arch) });
    else if (app) verifyUpdaterApp(app);
    else prepareReleaseUpdater(option('--client', core.paths(root).client));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
