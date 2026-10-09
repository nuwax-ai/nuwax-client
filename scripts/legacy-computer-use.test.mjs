import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const overlay = path.join(root, 'overlay/crates/agent-electron-client');

test('commercial prepare skips both legacy desktop automation resources; community retains them', () => {
  const script = path.join(overlay, 'scripts/prepare/prepare-all.js');
  for (const identifier of ['nuwax', 'nuwaclaw']) {
    const result = spawnSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8', env: { ...process.env, NUWAX_APP_IDENTIFIER: identifier } });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['gui-server', 'windows-mcp']) {
      assert.equal(result.stdout.includes(`[prepare-all] (dry-run) prepare:${name}`), identifier === 'nuwaclaw');
    }
  }
});

test('legacy calls stay inert even with stale settings/resources and cannot load old manager libraries', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-computer-use-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, api] of [['guiAgentServer', 'GuiAgentServer'], ['windowsMcp', 'WindowsMcp']]) {
    // Execute in isolation without Electron, uv or agent-gui-server dependencies.
    const source = fs.readFileSync(path.join(overlay, 'src/main/services/packages', `${name}.ts`), 'utf8');
    const file = path.join(directory, `${name}.mjs`);
    fs.writeFileSync(file, stripTypeScriptTypes(source));
    const module = await import(file);
    assert.equal((await module[`start${api}`]()).success, false);
    assert.deepEqual(await module[`stop${api}`](), { success: true });
    assert.deepEqual(module[`get${api}Status`](), { running: false });
    assert.equal(module[`get${api}Url`](), null);
    assert.equal(module[`is${api}Available`](), false);
  }
});

test('both release workflows exclude legacy payloads while retaining the CUA helper', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-ci-pack-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['release-electron.yml', 'release-electron-dev.yml']) {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    assert.ok(workflow.includes("--filter '!agent-gui-server'"));
    const command = workflow.split('\n').find(line => line.includes('const legacy=new Set'));
    const code = command.slice(command.indexOf('node -e "') + 9, command.lastIndexOf('"'));
    const payloads = ['agent-gui-server', 'windows-mcp', 'computer-use', 'node'];
    const entries = payloads.map(to => ({ from: `resources/${to}`, to }));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ build: { extraResources: entries, win: { extraResources: entries } } }));
    const result = spawnSync(process.execPath, ['-e', code], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const { build } = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.ok(build.files.includes('!node_modules/agent-gui-server/**/*'));
    assert.ok(build.files.includes('!node_modules/@nut-tree-fork/**/*'));
    for (const config of [build, build.win]) assert.deepEqual(config.extraResources.map(entry => entry.to), ['computer-use', 'node']);
  }
});
