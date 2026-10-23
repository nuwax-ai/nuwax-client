/** One Beta source build, consumed by every platform in the same workflow run. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';

function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return inventory(path.join(directory, entry.name), name + '/');
    if (!entry.isFile()) throw new Error('[frontend-artifact] Symlinks and special files are not admitted: ' + name);
    return [[name, core.fileHash(path.join(directory, entry.name))]];
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function describe(directory, sourceSha) {
  const index = path.join(directory, 'index.html');
  if (!fs.statSync(index).isFile() || !fs.statSync(index).size) throw new Error('[frontend-artifact] Missing index.html');
  const stamp = core.readJson(path.join(directory, 'version.json')).gitHash;
  if (typeof stamp !== 'string' || !/^[0-9a-f]{7,40}$/.test(stamp) || !sourceSha.startsWith(stamp)) throw new Error('[frontend-artifact] Stamp differs from frontend gitlink');
  const files = inventory(directory);
  // Match release-provenance's tree digest so platform manifests can be
  // compared directly with the producer's frontend digest.
  const hash = createHash('sha256');
  for (const [name, digest] of files) hash.update(name).update('\0').update(digest).update('\n');
  return { stamp, files, distSha256: hash.digest('hex') };
}

function sourceIdentity(root) {
  const client = core.git(root, ['rev-parse', 'HEAD']);
  const frontend = core.git(root, ['rev-parse', 'HEAD:nuwax']);
  if (![client, frontend].every(value => /^[0-9a-f]{40}$/.test(value))) throw new Error('[frontend-artifact] Invalid source identity');
  if (core.git(path.join(root, 'nuwax'), ['rev-parse', 'HEAD']) !== frontend) throw new Error('[frontend-artifact] Frontend checkout differs from gitlink');
  return { client, frontend };
}

export function createFrontendArtifact(root, destination, env = process.env) {
  const source = sourceIdentity(root);
  if (env.GITHUB_SHA !== source.client || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('[frontend-artifact] Requires a frozen GitHub workflow identity');
  if (fs.existsSync(destination)) throw new Error('[frontend-artifact] Refusing to overwrite artifact staging');
  const dist = path.join(root, 'nuwax/dist');
  const contents = describe(dist, source.frontend);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(dist, path.join(destination, 'dist'), { recursive: true });
  if (JSON.stringify(describe(path.join(destination, 'dist'), source.frontend)) !== JSON.stringify(contents)) throw new Error('[frontend-artifact] Staging changed frontend bytes');
  core.atomicJson(path.join(destination, 'manifest.json'), {
    schema: 1, source, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, ...contents,
  });
  return core.fileHash(path.join(destination, 'manifest.json'));
}

export function consumeFrontendArtifact(root, directory, expectedManifestSha256, env = process.env) {
  const manifestFile = path.join(directory, 'manifest.json');
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256 ?? '') || core.fileHash(manifestFile) !== expectedManifestSha256) throw new Error('[frontend-artifact] Manifest SHA256 differs from the producing job output');
  const manifest = core.readJson(manifestFile), source = sourceIdentity(root);
  // A failed-jobs-only rerun legitimately consumes the successful producer's
  // earlier attempt. Its artifact name and manifest digest remain pinned outputs.
  if (manifest.schema !== 1 || manifest.runId !== env.GITHUB_RUN_ID || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !/^[1-9]\d*$/.test(manifest.runAttempt ?? '')
    || Number(manifest.runAttempt) > Number(env.GITHUB_RUN_ATTEMPT) || JSON.stringify(manifest.source) !== JSON.stringify(source)) throw new Error('[frontend-artifact] Artifact is from another source or workflow run');
  const contents = describe(path.join(directory, 'dist'), source.frontend);
  for (const field of ['stamp', 'files', 'distSha256']) {
    if (JSON.stringify(contents[field]) !== JSON.stringify(manifest[field])) throw new Error('[frontend-artifact] Frontend content differs from manifest: ' + field);
  }
  const target = path.join(root, 'nuwax/dist');
  if (fs.existsSync(target)) throw new Error('[frontend-artifact] Refusing to overwrite frontend output');
  try {
    fs.cpSync(path.join(directory, 'dist'), target, { recursive: true });
    if (JSON.stringify(describe(target, source.frontend)) !== JSON.stringify(contents)) throw new Error('[frontend-artifact] Installed frontend bytes changed');
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  console.log('[frontend-artifact] admitted ' + source.frontend + ' sha256=' + contents.distSha256);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const [command, directory] = process.argv.slice(2);
  try {
    if (!directory || process.argv.length !== 4) throw new Error('usage: frontend-artifact.mjs create|consume DIRECTORY');
    if (command === 'create') console.log('manifest_sha256=' + createFrontendArtifact(root, path.resolve(directory)));
    else if (command === 'consume') consumeFrontendArtifact(root, path.resolve(directory), process.env.NUWAX_FRONTEND_MANIFEST_SHA256);
    else throw new Error('Unknown frontend artifact command');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
