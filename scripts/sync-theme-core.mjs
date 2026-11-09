#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelative = 'nuwax/src/features/themes/core';
const targetRelative = 'nuwa-electron-shell/crates/agent-electron-client/src/shared/features/themes/core';

/** 前端可独立构建；壳使用同源快照，不跨仓导入前端运行时。 */
export function syncThemeCore(root = defaultRoot, { check = false } = {}) {
  const source = path.join(root, sourceRelative);
  const target = path.join(root, targetRelative);
  const entries = fs.readdirSync(source).filter(name => name.endsWith('.mjs') && !/\.(test|config)\./.test(name)).sort();
  if (!entries.includes('index.mjs')) throw new Error('Canonical theme core is missing');
  const expectedNames = new Set(entries.map(name => name.replace(/\.mjs$/, '.ts')));
  expectedNames.add('types.ts'); expectedNames.add('dom.ts'); expectedNames.add('archive.ts');
  const declarations = fs.readFileSync(path.join(source, 'index.d.mts'), 'utf8');
  const typeNames = [...declarations.matchAll(/^export (?:type|interface) (\w+)/gm)].map(match => match[1]);
  let changed = false;
  for (const name of entries) {
    const generatedName = name.replace(/\.mjs$/, '.ts');
    const content = '// @ts-nocheck\n' +
      `// Generated from ${sourceRelative}/${name}; do not edit.\n` +
      '// Refresh: node scripts/sync-theme-core.mjs\n\n' +
      fs.readFileSync(path.join(source, name), 'utf8').replace(/(['"])(\.\.?\/[^'"\n]+)\.mjs\1/g, '$1$2$1') +
      (name === 'index.mjs' ? `\nexport type { ${typeNames.join(', ')} } from './types';\n` : '');
    const destination = path.join(target, generatedName);
    const actual = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : null;
    if (actual === content) continue;
    changed = true;
    if (check) throw new Error(`Theme core snapshot is stale: ${generatedName}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(destination, content);
  }
  const extras = {
    'archive.ts': '// @ts-nocheck\n// Generated from nuwax/src/features/themes/archive.ts; do not edit.\n' +
      fs.readFileSync(path.join(root, 'nuwax/src/features/themes/archive.ts'), 'utf8').replace(/from '\.\/core'/g, "from './index'"),
    'types.ts': `// Generated from ${sourceRelative}/index.d.mts; do not edit.\n` + declarations.replace(/^export (function|const) /gm, 'export declare $1 '),
    'dom.ts': '// @ts-nocheck\n// Generated from nuwax/src/features/themes/dom.ts; do not edit.\n' +
      fs.readFileSync(path.join(root, 'nuwax/src/features/themes/dom.ts'), 'utf8')
        .replace(/from '\.\/core'/g, "from './index'")
        .replace(/from '\.\.\/\.\.\/types\/interfaces\/hostBridge'/g, "from '../../../types/hostBridge'"),
  };
  for (const [name, content] of Object.entries(extras)) {
    const destination = path.join(target, name);
    if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') === content) continue;
    changed = true;
    if (check) throw new Error(`Theme core snapshot is stale: ${name}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(destination, content);
  }
  if (fs.existsSync(target)) {
    for (const name of fs.readdirSync(target)) {
      if (expectedNames.has(name)) continue;
      changed = true;
      if (check) throw new Error(`Unexpected theme core snapshot: ${name}`);
      fs.unlinkSync(path.join(target, name));
    }
  }
  const frontend = JSON.parse(fs.readFileSync(path.join(root, 'nuwax/package.json'), 'utf8'));
  const shell = JSON.parse(fs.readFileSync(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json'), 'utf8'));
  for (const dependency of ['postcss', 'postcss-selector-parser', 'postcss-value-parser', 'jszip']) {
    if (frontend.dependencies?.[dependency] !== shell.dependencies?.[dependency]) {
      throw new Error(`Theme parser dependency versions differ: ${dependency}`);
    }
  }
  return { changed, files: entries.length + 3 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = syncThemeCore(defaultRoot, { check: process.argv.includes('--check') });
    console.log(`[themes] ${result.files} core snapshots ${result.changed ? 'updated' : 'match'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
