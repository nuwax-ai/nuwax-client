#!/usr/bin/env node
// Compatibility entrypoint; all argument parsing lives in the shared client CLI.
import('./client/cli.mjs').then(({ main }) => main(['sub:update', ...process.argv.slice(2)])).catch((error) => {
  console.error(`[sub:update] ${error.message}`);
  process.exitCode = 1;
});
