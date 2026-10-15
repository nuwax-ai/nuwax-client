#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTerminalCompatResources, verifyPackagedTerminalCompat } from './client/terminal-compat-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
try {
  const output = option('--verify-output', null);
  if (output) {
    const verified = verifyPackagedTerminalCompat(root, output, { platform: option('--platform', process.platform), arch: option('--arch', process.arch) });
    console.log(`[terminal] Verified packaged resources: ${verified.join(', ')}`);
  } else {
    const directory = await prepareTerminalCompatResources(root, {
      platform: option('--platform', process.platform), arch: option('--arch', process.arch), refreshResources: args.includes('--refresh'),
    });
    console.log(`[terminal] ${directory ?? 'Current platform uses the existing ttyd backend'}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
