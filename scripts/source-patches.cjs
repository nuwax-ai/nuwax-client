const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function fileServerPatch(root, sourceUrl) {
  if (sourceUrl !== 'https://github.com/nuwax-ai/nuwax-file-server.git') return undefined;
  const file = path.join(root, 'resources/source-patches/nuwax-file-server-http-listener.patch');
  return { file, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

/** Apply only to a disposable build copy, never to the developer's sources or source cache. */
function createPatchedSource(source, patch) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-bundled-source-'));
  try {
    fs.cpSync(source, directory, { recursive: true,
      filter: (file) => !['.git', 'node_modules', 'dist'].includes(path.basename(file)) });
    const options = { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    try {
      execFileSync('git', ['apply', '--ignore-space-change', '--check', patch], options);
      execFileSync('git', ['apply', '--ignore-space-change', patch], options);
    } catch (error) {
      // Once upstream carries the same fix, the product patch remains idempotent.
      try { execFileSync('git', ['apply', '--reverse', '--ignore-space-change', '--check', patch], options); }
      catch { throw new Error(`Bundled source patch no longer applies: ${patch}`, { cause: error }); }
    }
    return { directory, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { fileServerPatch, createPatchedSource };
