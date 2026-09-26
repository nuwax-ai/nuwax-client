import fs from 'node:fs';
import path from 'node:path';
import { paths, run, git, readJson } from './core.mjs';
import { resourceSpecs, fileReady, electronBinary, packageReady, runtimeDependenciesReady, sourceNames } from './prepare.mjs';

export function doctor(root, options = {}) {
  const p = paths(root), issues = [];
  const inspect = command => {
    const result = run(command, ['--version'], { capture: true, allowFailure: true });
    return { available: result.status === 0, version: result.stdout.trim().split('\n')[0] || null };
  };
  const tools = { node: { available: true, version: process.version }, git: inspect('git'), corepack: inspect('corepack') };
  if (!tools.git.available) issues.push('Install Git');
  if (Number(process.versions.node.split('.')[0]) < 22) issues.push('Use Node 22 or newer');
  const modules = ['nuwa-electron-shell', 'nuwax', 'nuwax-dist'].map(name => {
    const dir = path.join(root, name), initialized = fs.existsSync(path.join(dir, '.git'));
    const rawPin = git(root, ['rev-parse', 'HEAD:' + name], { allowFailure: true });
    const pinned = /^[a-f0-9]{40}$/.test(rawPin) ? rawPin : null;
    const head = initialized ? git(dir, ['rev-parse', 'HEAD'], { allowFailure: true }) : null;
    const status = initialized ? git(dir, ['status', '--porcelain'], { allowFailure: true }) : null;
    if (!initialized) issues.push('Initialize ' + name);
    else if (pinned !== head) issues.push(name + ' HEAD differs from committed pin');
    if (name === 'nuwax-dist' && status) issues.push('nuwax-dist has local edits; restore/publish them before consuming the pin');
    return { name, initialized, pinned, head, dirty: Boolean(status) };
  });
  let stamp = null;
  try { stamp = readJson(path.join(p.dist, 'version.json')).gitHash; } catch {}
  const sourcePin = modules.find(item => item.name === 'nuwax').pinned;
  const frontendReady = fileReady(path.join(p.dist, 'index.html')) && typeof stamp === 'string' &&
    /^[a-f0-9]{7,40}$/.test(stamp) && Boolean(sourcePin?.startsWith(stamp));
  if (!frontendReady) issues.push('Build/publish matching frontend assets with npm run sub:update');
  const dependenciesReady = fs.existsSync(path.join(p.client, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'));
  if (!dependenciesReady) issues.push('Client dependencies will be prepared by dev/pack');
  const nativeReady = fileReady(electronBinary(p.client)) && fileReady(path.join(p.client, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
  if (!nativeReady) issues.push('Electron/native modules will be prepared by dev/pack');
  const resources = resourceSpecs(p.client).map(item => ({
    name: item.name, optional: Boolean(item.optional), ready: item.files.every(fileReady) && (!item.check || item.check()),
  }));
  for (const name of sourceNames) {
    const directory = path.join(p.client, 'resources', name);
    resources.push({ name, optional: false, ready: packageReady(directory) && runtimeDependenciesReady(directory) });
  }
  const helper = path.join(p.client, 'resources/computer-use', process.platform === 'darwin' ? 'Nuwax Computer Use.app/Contents/MacOS/Nuwax Computer Use' : process.platform === 'win32' ? 'NuwaxComputerUse.exe' : 'NuwaxComputerUse');
  for (const item of resources.filter(item => !item.ready && !item.optional)) issues.push('Prepare resource: ' + item.name);
  const result = { ready: issues.length === 0, root, tools, modules,
    frontend: { ready: frontendReady, dir: p.dist, stamp, sourcePin }, dependenciesReady, nativeReady, resources,
    packaging: { computerUseReady: fileReady(helper), helper, preparedAutomatically: true }, issues };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('[doctor] ' + (result.ready ? 'ready' : 'preparation required'));
    for (const issue of issues) console.log('  - ' + issue);
    console.log('[doctor] dev/pack automatically prepare repository dependencies and resources');
  }
  return result;
}
