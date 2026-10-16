import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { commentOnly, compareRefs, selectChecks } from './ci-scope.mjs';

test('documentation, business code and base upgrades select their actual validation domains', () => {
  const enabled = files => Object.entries(selectChecks(files)).filter(([k, v]) => k !== 'script_tests' && v).map(([k]) => k).sort();
  assert.deepEqual(enabled(['docs/native-capture-api.md', 'plans/old-plan.md']), []);
  assert.deepEqual(enabled(['overlay/crates/agent-electron-client/src/renderer/App.tsx']), ['commercial']);
  assert.deepEqual(enabled(['nuwa-electron-shell']), ['commercial', 'community', 'compatibility', 'scripts']);
  assert.deepEqual(enabled(['nuwax']), ['frontend', 'host_bridge']);
  assert.deepEqual(enabled(['native/legacy-terminal/session_windows.go']), ['scripts', 'terminal']);
  const full = selectChecks([], { full: true });
  for (const key of ['commercial', 'community', 'frontend', 'terminal', 'host_bridge', 'compatibility', 'scripts']) assert.equal(full[key], true);
  assert.deepEqual(selectChecks(['unknown/runtime.rs']), full);
  assert.deepEqual(selectChecks(['pnpm-lock.yaml']), full);
});

test('script selection follows shared imports and falls back to all tests when ownership is unknown', () => {
  const selected = selectChecks(['scripts/client/system-app-name.mjs']);
  assert.ok(selected.script_tests.includes('scripts/system-app-name.test.mjs'));
  assert.ok(!selected.script_tests.includes('scripts/check-base-purity.test.mjs'));
  assert.equal(selected.commercial, false);
  assert.deepEqual(selectChecks(['overlay/crates/agent-electron-client/src/main/services/packages/guiAgentServer.ts']).script_tests, ['scripts/legacy-computer-use.test.mjs']);
  assert.ok(selectChecks(['scripts/new-tool.mjs']).script_tests.length > selected.script_tests.length);
  assert.deepEqual(selectChecks(['.claude/hooks/guard-paths.mjs']).script_tests, ['scripts/agent-hooks.test.mjs']);
});

test('ordinary comments can skip tests, while executable strings, syntax errors and tool annotations cannot', () => {
  assert.equal(commentOnly('a.ts', '// old\nconst a = 1;', '// new\nconst a = 1;'), true);
  assert.equal(commentOnly('a.tsx', 'const a = <div>{/* old */}ok</div>;', 'const a = <div>{/* new */}ok</div>;'), true);
  for (const [a, b] of [
    ['const a = 1;', 'const a = 2;'],
    ['const a = `\n// old\n`;', 'const a = `\n// new\n`;'],
    ['// old\nconst a = 1;', '// @ts-ignore\nconst a = 1;'],
    ['const a = init();', 'const a = /* @__PURE__ */ init();'],
    ['const a = init();', '/* eslint-disable */ const a = init();'],
    ['const a = init();', '/* istanbul ignore next */ const a = init();'],
    ['const a = import("./a.js");', 'const a = import(/* webpackIgnore: true */ "./a.js");'],
    ['const a = 1;', '/* const a = 1; */'],
    ['const = 1;', 'const = 1; // comment'],
  ]) assert.equal(commentOnly('a.ts', a, b), false);
  assert.equal(commentOnly('a.ts', null, '// new'), false);
});

test('Git comparisons include deletions and executable changes, and an unreadable baseline forces full checks', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-scope-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'fixture']);
  fs.writeFileSync(path.join(cwd, 'a.ts'), '// old\nexport const a = 1;');
  fs.writeFileSync(path.join(cwd, 'deleted.ts'), 'export const old = 1;');
  git(['add', '.']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const before = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'a.ts'), '// new\nexport const a = 1;');
  fs.unlinkSync(path.join(cwd, 'deleted.ts'));
  fs.writeFileSync(path.join(cwd, 'new.ts'), 'export const value = 2;');
  git(['add', '.']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'changes']);
  assert.deepEqual(compareRefs(before, 'HEAD', { cwd }), ['deleted.ts', 'new.ts']);
  const run = spawnSync(process.execPath, [new URL('./ci-scope.mjs', import.meta.url).pathname, '--base', 'unresolvable-fixture-ref'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).script_tests, selectChecks([], { full: true }).script_tests);
  assert.equal(JSON.parse(run.stdout).community, true);
});

test('the actual workflow applies domain selection and callable releases default to complete checks', () => {
  const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.workflow_call.inputs.full.default, true);
  for (const files of [[], ['docs/guide.md'], ['overlay/crates/agent-electron-client/src/main/a.ts'], ['nuwa-electron-shell'], ['nuwax'], ['native/legacy-terminal/a.go']]) {
    const selected = selectChecks(files);
    const needs = { scope: { outputs: Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, String(v)])) } };
    for (const [job, expected] of Object.entries({ community: selected.community, commercial: selected.commercial || selected.scripts || selected.host_bridge, frontend: selected.frontend, 'terminal-compat': selected.terminal })) {
      assert.equal(workflow.jobs[job].needs, 'scope');
      assert.equal(Function('needs', `return (${workflow.jobs[job].if});`)(needs), expected, `${job}: ${files}`);
    }
  }
});
