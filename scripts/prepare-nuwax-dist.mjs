#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { withLock } from './client/core.mjs';
import { preparePinnedFrontend, usePinnedFrontendDist } from './client/frontend.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== '--pinned') {
  console.error('[prepare-nuwax-dist] usage: prepare-nuwax-dist.mjs [--pinned]');
  process.exit(2);
}
withLock(root, 'frontend', () => args[0] === '--pinned' ? usePinnedFrontendDist(root) : preparePinnedFrontend(root)).catch(error => {
  console.error('[prepare-nuwax-dist] ' + error.message);
  process.exitCode = 1;
});
