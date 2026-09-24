import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('diagnostic export summarizes errors without copying credentials or messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'nuwax-diagnostics-'));
  try {
    const logs = join(root, 'logs');
    const output = join(root, 'diagnostics.json');
    mkdirSync(logs);
    writeFileSync(join(logs, 'main.2026-09-23.log'),
      '[2026-09-23] ERROR [LoopbackGateway] [SecretToken] ticket=secret-value Bearer private-value ECONNRESET\n');
    const result = spawnSync(process.execPath,
      [new URL('./export-diagnostics.mjs', import.meta.url).pathname, '--log-dir', logs, '--output', output],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const raw = readFileSync(output, 'utf8');
    assert.doesNotMatch(raw, /secret-value|private-value|Bearer|ticket=|SecretToken/);
    const value = JSON.parse(raw);
    assert.equal(value.logSummaries[0].codes.ECONNRESET, 1);
    assert.equal(value.logSummaries[0].components.LoopbackGateway, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
