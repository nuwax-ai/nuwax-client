import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import signing from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/windows-signing.cjs';

test('new update scripts are shipped and covered by the signed-code source inventory', t => {
  const client = path.resolve('nuwa-electron-shell/crates/agent-electron-client');
  const pkg = JSON.parse(fs.readFileSync(path.join(client, 'package.json')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'update-signing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['installer-runtime.ps1', 'installer-monitor.ps1']) {
    const entry = pkg.build.win.extraResources.find(item => item.to === 'installer/' + name);
    assert.equal(entry?.from, 'build/' + name);
    const source = fs.readFileSync(path.join(client, entry.from));
    const shipped = path.join(directory, 'resources', entry.to);
    fs.mkdirSync(path.dirname(shipped), { recursive: true });
    fs.writeFileSync(shipped, source);
  }
  const baseline = signing.inventory(directory);
  assert.throws(() => signing.verifyTree(directory, baseline), /Unsigned packaged PowerShell/);
  const signature = '\n# SIG # Begin signature block\n# synthetic source-gate fixture, not a cryptographic signature\n# SIG # End signature block\n';
  for (const name of Object.keys(baseline)) fs.appendFileSync(path.join(directory, name), signature);
  signing.verifyTree(directory, baseline);
  fs.appendFileSync(path.join(directory, 'resources/installer/installer-monitor.ps1'), 'changed after signing\n');
  assert.throws(() => signing.verifyTree(directory, baseline), /Incomplete PowerShell signature|Script code differs/);
});
