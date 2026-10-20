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

test('diagnostic export follows automatic runtime endpoints instead of legacy fixed ports', () => {
  const root = mkdtempSync(join(tmpdir(), 'nuwax-runtime-ports-'));
  try {
    const logs = join(root, 'logs'); const output = join(root, 'diagnostics.json');
    mkdirSync(logs);
    writeFileSync(join(logs, 'main.2026-10-20.log'),
      '[INFO] [LocalPorts] fileServer reserved 127.0.0.1:24600 generation=1 skipped=0\n' +
      '[WARN] [FileServer] EADDRINUSE\n' +
      '[INFO] [LocalPorts] fileServer ready 127.0.0.1:24608 generation=2\n');
    const result = spawnSync(process.execPath,
      [new URL('./export-diagnostics.mjs', import.meta.url).pathname, '--log-dir', logs, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(value.localEndpoints, [{ service: 'fileServer', host: '127.0.0.1', port: 24608, status: 'ready', generation: 2 }]);
    assert.deepEqual(value.localPortReachability.map((item) => item.port), [24608]);
    assert.equal(value.logSummaries[0].codes.EADDRINUSE, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
