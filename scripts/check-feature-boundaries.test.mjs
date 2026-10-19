import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkFeatureBoundaries, classify, extractImports, overlaySrc } from './check-feature-boundaries.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, overlaySrc, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

const rules = (root) => checkFeatureBoundaries(root).map((v) => `${v.rule}:${v.file}`).sort();

test('classify distinguishes feature, kit, registry and other paths', () => {
  assert.deepEqual(classify('main/features/capture/service'), { kind: 'feature', area: 'main', id: 'capture' });
  assert.deepEqual(classify('main/features/_kit/types'), { kind: 'kit', area: 'main', id: '_kit' });
  assert.deepEqual(classify('main/features/index'), { kind: 'registry', area: 'main', id: 'index' });
  assert.deepEqual(classify('preload/features/capture'), { kind: 'feature', area: 'preload', id: 'capture' });
  assert.deepEqual(classify('preload/features/capture.test'), { kind: 'feature', area: 'preload', id: 'capture' });
  assert.deepEqual(classify('shared/features/capture/contract'), { kind: 'feature', area: 'shared', id: 'capture' });
  assert.deepEqual(classify('main/ipc/nuwaxBridgeHandlers'), { kind: 'other' });
  assert.deepEqual(classify('main/features'), { kind: 'other' });
});

test('extractImports finds static, side-effect, re-export, dynamic and require forms', () => {
  const src = [
    "import a from './a';",
    "import type { B } from '../b';",
    "import './side';",
    "export * from './reexport';",
    "export { x } from '@shared/x';",
    "const c = await import('./dyn');",
    "const d = require('./req');",
  ].join('\n');
  assert.deepEqual(extractImports(src).sort(), ['./a', './dyn', './reexport', './req', './side', '../b', '@shared/x'].sort());
});

test('a well-formed feature, kit and registry produce no violations', (t) => {
  const root = fixture(t, {
    'main/features/_kit/types.ts': "import { x } from './helper';\nimport fs from 'node:fs';",
    'main/features/_kit/helper.ts': 'export const x = 1;',
    'main/features/index.ts': "import { cap } from './capture';\nimport type { T } from './_kit/types';\nexport const all = [cap];",
    'main/features/capture/index.ts': "import type { T } from '../_kit/types';\nimport { c } from '@shared/features/capture/contract';\nimport { s } from './service';\nimport { app } from 'electron';",
    'main/features/capture/service.ts': "import { c } from '@shared/features/capture/contract';",
    'main/features/capture/service.test.ts': "import { it } from 'vitest';\nimport { s } from './service';",
    'shared/features/capture/contract.ts': 'export const c = 1;',
    'preload/features/index.ts': "import { b } from './capture';\nimport { c } from '@shared/features/capture/contract';",
    'preload/features/capture.ts': "import { c } from '@shared/features/capture/contract';",
    'main/ipc/handlers.ts': "import { all } from '../features';\nimport { c } from '@shared/features/capture/contract';",
  });
  assert.deepEqual(rules(root), []);
});

test('R1: a feature must not import client code or another feature', (t) => {
  const root = fixture(t, {
    'main/features/capture/a.ts': "import { db } from '@main/db';\nimport { x } from '../../services/system/deviceId';\nimport { y } from '../other/impl';\nimport { z } from '@shared/constants';",
    'main/features/other/impl.ts': 'export const y = 1;',
  });
  const out = checkFeatureBoundaries(root).filter((v) => v.rule === 'R1');
  assert.equal(out.length, 4);
  assert.ok(out.every((v) => v.file === 'main/features/capture/a.ts'));
});

test('R1: a feature may use shared/types/hostBridge and the kit', (t) => {
  const root = fixture(t, {
    'main/features/_kit/types.ts': 'export type T = 1;',
    'main/features/capture/a.ts': "import type { H } from '@shared/types/hostBridge';\nimport type { T } from '../_kit/types';",
  });
  assert.deepEqual(rules(root), []);
});

test('R2: outside code must not reach into feature internals', (t) => {
  const root = fixture(t, {
    'main/features/capture/service.ts': 'export const s = 1;',
    'shared/features/capture/contract.ts': 'export const c = 1;',
    'shared/features/capture/tiers.ts': 'export const t = 1;',
    'main/ipc/handlers.ts': "import { s } from '../features/capture/service';\nimport { t } from '@shared/features/capture/tiers';\nimport { c } from '@shared/features/capture/contract';",
  });
  const out = checkFeatureBoundaries(root).filter((v) => v.rule === 'R2');
  assert.equal(out.length, 2, 'public contract is allowed; service and tiers are not');
});

test('R2: renderer features expose only their index entry', (t) => {
  const root = fixture(t, {
    'renderer/features/notices/index.tsx': 'export const N = 1;',
    'renderer/features/notices/List.tsx': 'export const L = 1;',
    'renderer/components/pages/CommercialAboutPage.tsx': "import { N } from '../../features/notices';\nimport { L } from '../../features/notices/List';",
  });
  const out = checkFeatureBoundaries(root).filter((v) => v.rule === 'R2');
  assert.equal(out.length, 1);
  assert.match(out[0].message, /List/);
});

test('R3: the kit must not depend on features or client code', (t) => {
  const root = fixture(t, {
    'main/features/_kit/types.ts': "import { c } from '../capture/service';\nimport { d } from '@main/db';",
    'main/features/capture/service.ts': 'export const c = 1;',
  });
  assert.equal(checkFeatureBoundaries(root).filter((v) => v.rule === 'R3').length, 2);
});

test('R4: product identity literals are forbidden inside features (tests excepted)', (t) => {
  const root = fixture(t, {
    'main/features/capture/a.ts': "if (APP_NAME_IDENTIFIER === 'nuwax') {}",
    'main/features/capture/a.test.ts': "expect(APP_NAME_IDENTIFIER).toBe('x');",
  });
  assert.deepEqual(rules(root), ['R4:main/features/capture/a.ts']);
});

test('registry test files retain the registry boundary, rather than becoming a feature', () => {
  assert.equal(classify('main/features/index.test').kind, 'registry');
  assert.equal(classify('preload/features/index.spec').kind, 'registry');
  assert.equal(classify('main/features/capture/service.test').id, 'capture');
});

test('the real overlay tree satisfies every boundary rule', () => {
  const violations = checkFeatureBoundaries();
  assert.deepEqual(violations, [], violations.map((v) => `${v.rule} ${v.file}: ${v.message}`).join('\n'));
});

test('R5: the kit must not carry feature id string literals; comments are exempt', (t) => {
  const root = fixture(t, {
    'main/features/_kit/types.ts': "export const a = 'capture';\n// 注释里的 computer-use 与 /* local-files */ 不算\nexport const b = `x`;",
    'main/features/_kit/helper.ts': 'export const y = 1;',
    'main/features/capture/index.ts': 'export const c = 1;',
  });
  const out = checkFeatureBoundaries(root).filter((v) => v.rule === 'R5');
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'main/features/_kit/types.ts');
});

test('R5: the registry may import feature entries only, not feature internals', (t) => {
  const root = fixture(t, {
    'main/features/index.ts': "import { a } from './capture';\nimport { b } from './capture/impl';\nexport const all = [a, b];",
    'main/features/capture/index.ts': "import { i } from './impl';\nexport const a = i;",
    'main/features/capture/impl.ts': 'export const i = 1;',
    'preload/features/index.ts': "import { p } from './capture';\nexport const ps = p;",
    'preload/features/capture.ts': 'export const p = 1;',
  });
  const out = checkFeatureBoundaries(root).filter((v) => v.rule === 'R2');
  assert.deepEqual(out.map((v) => v.file), ['main/features/index.ts']);
});
