#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCaptureResources } from './client/capture-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
try {
  const resource = await prepareCaptureResources(root, { platform: option('--platform', process.platform), arch: option('--arch', process.arch), refreshResources: argv.includes('--refresh') });
  console.log(`[capture] ${resource ?? '当前平台不提供录屏编码资源'}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
