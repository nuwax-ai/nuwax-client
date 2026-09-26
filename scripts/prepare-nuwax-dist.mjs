#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { withLock } from './client/core.mjs';
import { preparePinnedFrontend } from './client/frontend.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
withLock(root, 'frontend', () => preparePinnedFrontend(root)).catch(error => {
  console.error('[prepare-nuwax-dist] ' + error.message);
  process.exitCode = 1;
});
