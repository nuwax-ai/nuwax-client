'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sources = Object.freeze({
  'file-server': { name: 'nuwax-file-server', env: 'NUWAX_FILE_SERVER' },
  'claude-acp': { name: 'claude-code-acp-ts', env: 'NUWAX_CLAUDE_ACP' },
});
const marker = '.nuwax-build-cache.json';

function sourceIdentity(kind, env = process.env) {
  const prefix = Object.hasOwn(sources, kind) ? sources[kind].env : null;
  if (!prefix) throw new Error('Unknown prepared source');
  const revision = env[prefix + '_SOURCE_SHA'], key = env[prefix + '_CACHE_KEY'];
  if (!revision && !key) return null;
  if (!/^[a-f0-9]{40}$/.test(revision || '') || !/^[a-zA-Z0-9._-]{1,180}$/.test(key || '')) throw new Error('Invalid fixed source identity');
  return { revision, key };
}

function lockedInstallCommand(source) {
  if (fs.existsSync(path.join(source, 'package-lock.json'))) return 'npm ci --ignore-scripts';
  // Match the upstream pnpm lock, while materializing ordinary files instead of
  // workspace/store links that cannot be admitted into a standalone resource.
  if (fs.existsSync(path.join(source, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace --node-linker=hoisted --package-import-method=copy';
  return 'npm install --ignore-scripts';
}

function preparedSourceReady(kind, directory, env = process.env) {
  const identity = sourceIdentity(kind, env);
  if (!identity) return false;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(directory, marker)));
    return record.key === identity.key && record.revision === identity.revision && /^[a-f0-9]{64}$/.test(record.lockSha256)
      && fs.statSync(path.join(directory, 'package.json')).isFile()
      && fs.statSync(path.join(directory, 'dist')).isDirectory()
      && fs.statSync(path.join(directory, 'node_modules')).isDirectory();
  } catch { return false; }
}

function recordPreparedSource(kind, source, directory, env = process.env) {
  const identity = sourceIdentity(kind, env);
  if (!identity) return;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  if (head !== identity.revision) throw new Error('Prepared source differs from the frozen revision');
  const lockFile = ['package-lock.json', 'pnpm-lock.yaml'].find(name => fs.existsSync(path.join(source, name)));
  if (!lockFile) return; // Unlocked npm install remains usable, never reusable across releases.
  const lock = path.join(source, lockFile);
  try { execFileSync('git', ['ls-files', '--error-unmatch', lockFile], { cwd: source, stdio: 'pipe' }); }
  catch { return; }
  const { createHash } = require('node:crypto');
  const lockSha256 = createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
  fs.writeFileSync(path.join(directory, marker), JSON.stringify({ ...identity, lockSha256 }) + '\n');
  if (env.GITHUB_ACTIONS === 'true') {
    try { execFileSync(process.execPath, [path.join(__dirname, 'build-resource-artifacts.mjs'),
      'invalidate', kind, identity.key, 'inner-cache-miss'], { env, stdio: 'inherit' }); }
    catch (error) { console.warn('[fixed-dependency-cache] Unable to refresh optional cache state: ' + error.message); }
  }
}

module.exports = { sources, marker, sourceIdentity, preparedSourceReady, recordPreparedSource, lockedInstallCommand };
