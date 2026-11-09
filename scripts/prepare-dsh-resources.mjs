#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareDshResources } from './client/dsh-resources.mjs';
const { values } = parseArgs({ options: {
  platform: { type: 'string' }, arch: { type: 'string' }, refresh: { type: 'boolean' }, cache: { type: 'string' },
} });
try {
  const result = await prepareDshResources(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    { platform: values.platform, arch: values.arch, refreshResources: values.refresh, cache: values.cache });
  console.log('[dsh] Runtime prepared: ' + result.key);
} catch (error) { console.error(error.message); process.exitCode = 1; }
