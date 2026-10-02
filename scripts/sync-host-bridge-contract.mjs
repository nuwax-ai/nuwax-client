#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hostBridgeSource = 'nuwax/src/types/interfaces/hostBridge.ts';
export const hostBridgeSnapshot = 'overlay/crates/agent-electron-client/src/shared/types/hostBridge.ts';
const generatedNotice = `// Generated from ${hostBridgeSource}; do not edit.\n// Refresh: node scripts/sync-host-bridge-contract.mjs\n\n`;
const normalizeLineEndings = text => text.replace(/\r\n/g, '\n');

/** 只生成契约快照；不改基座检出、子模块 pin 或源码事实源。 */
export function syncHostBridgeContract(root = defaultRoot, { check = false } = {}) {
  const source = path.join(root, hostBridgeSource);
  const snapshot = path.join(root, hostBridgeSnapshot);
  const expected = generatedNotice + normalizeLineEndings(fs.readFileSync(source, 'utf8'));
  const current = fs.existsSync(snapshot) ? normalizeLineEndings(fs.readFileSync(snapshot, 'utf8')) : null;
  const changed = current !== expected;
  if (check && changed) throw new Error('Host bridge contract snapshot is stale; run node scripts/sync-host-bridge-contract.mjs');
  if (!check && changed) {
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, expected);
  }
  return { source, snapshot, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let root = defaultRoot, check = false;
    for (let i = 2; i < process.argv.length; i++) {
      const argument = process.argv[i];
      if (argument === '--check') check = true;
      else if (argument === '--root' && process.argv[i + 1]) root = path.resolve(process.argv[++i]);
      else throw new Error(`Unknown argument: ${argument}`);
    }
    const result = syncHostBridgeContract(root, { check });
    console.log(`[host-bridge] ${check ? 'Contract snapshot matches source' : result.changed ? 'Contract snapshot generated' : 'Contract snapshot already current'}`);
  } catch (error) {
    console.error(`[host-bridge] ${error.message}`);
    process.exitCode = 1;
  }
}
