import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from './core.mjs';

// Commercial dependencies live outside the neutral base workspace. Node,
// TypeScript and esbuild resolve them from this parent node_modules; the pure
// JS runtime dependencies are bundled into the commercial main entry point.
export async function ensureCommercialDependencies(root, tools = core) {
  const manifest = path.join(root, 'package.json');
  const lock = path.join(root, 'pnpm-lock.yaml');
  const pkg = tools.readJson(manifest);
  const dependencies = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies });
  if (!dependencies.length) return;
  const marker = path.join(tools.paths(root).cache, 'commercial-dependencies.json');
  const key = tools.fingerprint([tools.fileHash(manifest), tools.fileHash(lock), process.version, process.platform, process.arch]);
  const packagesReady = () => dependencies.every(([name, version]) => {
    try { return tools.readJson(path.join(root, 'node_modules', name, 'package.json')).version === version; }
    catch { return false; }
  });
  const ready = () => {
    try { return tools.readJson(marker).key === key && packagesReady(); }
    catch { return false; }
  };
  if (ready()) return;
  await tools.withLock(root, 'commercial-dependencies', async () => {
    if (ready()) return;
    await tools.pnpmRun(root, ['install', '--frozen-lockfile', '--ignore-scripts', '--prod=false'], { env: { CI: 'true' } });
    if (!packagesReady()) throw new Error('[prepare] 商业依赖入口缺失或版本不匹配');
    tools.atomicJson(marker, { key });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  try { await ensureCommercialDependencies(root); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
