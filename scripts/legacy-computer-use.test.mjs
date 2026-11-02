import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const client = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
const retired = ['sandboxed-bash-mcp', 'sandboxed-fs-mcp', 'sandbox-runtime', 'sandbox-helper', 'agent-gui-server', 'windows-mcp'];

test('the internal shell resource plan contains current tools without retired automation in any identity', () => {
  for (const identifier of ['nuwax', 'nuwaclaw']) {
    const result = spawnSync(process.execPath, [path.join(client, 'scripts/prepare/prepare-all.js'), '--dry-run'], {
      encoding: 'utf8', env: { ...process.env, NUWAX_APP_IDENTIFIER: identifier },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['gui-server', 'windows-mcp', 'sandboxed-mcp', 'sandbox-helper-win', 'sandbox-runtime']) {
      assert.ok(!result.stdout.includes(`prepare:${name}`), result.stdout);
    }
    for (const name of ['node', 'harness', 'nuwax-file-server', 'mcp-proxy', 'ttyd']) {
      assert.ok(result.stdout.includes(`prepare:${name}`), result.stdout);
    }
  }
});

test('the source packaging manifest does not depend on retired automation payloads or workspace crates', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(client, 'package.json'), 'utf8'));
  const entries = [...pkg.build.extraResources, ...pkg.build.win.extraResources];
  for (const name of retired) {
    assert.ok(!entries.some(entry => entry.to === name));
    assert.ok(!Object.hasOwn(pkg.dependencies, name));
    assert.ok(!Object.hasOwn(pkg.devDependencies, name));
  }
  for (const name of ['node', 'nuwax-file-server', 'nuwax-harness-acp-ts', 'ttyd']) {
    assert.ok(entries.some(entry => entry.to === name));
  }
});
