import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('configured agent hooks allow source edits and retain credential, force-push and publication protection', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.sdlc.json'), JSON.stringify({ envPrefix: 'HOOK_TEST', deployGate: { patterns: [
    { re: '\\bgit push\\b[^&|;]*(--force|-f)(\\s|$)', mode: 'block' },
    { re: '\\bdocker push\\b', mode: 'ask' },
  ] } }));
  for (const [tool_name, tool_input, approved, expected] of [
    ['Edit', { file_path: path.join(dir, 'overlay/source.ts') }, false, 0],
    ['Write', { file_path: path.join(dir, '.env') }, false, 2],
    ['Write', { file_path: path.join(dir, '.env.example') }, false, 0],
    ['Bash', { command: 'cat /etc/certs/server.pem' }, false, 2],
    ['Bash', { command: 'git push origin main --force' }, true, 2],
    ['Bash', { command: 'docker push repo:1' }, false, 2],
    ['Bash', { command: 'docker push repo:1' }, true, 0],
  ]) {
    const config = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url)));
    const hooks = config.hooks.PreToolUse.filter(h => h.matcher.split('|').includes(tool_name)).flatMap(h => h.hooks);
    const results = hooks.map(h => {
      const file = h.command.split(' ').at(-1);
      return spawnSync(process.execPath, [fileURLToPath(new URL(`../${file}`, import.meta.url))], {
        input: JSON.stringify({ tool_name, tool_input, cwd: dir }), encoding: 'utf8',
        env: { ...process.env, HOOK_TEST_APPROVE_DEPLOY: approved ? '1' : '0' },
      });
    });
    assert.ok(results.length > 0);
    assert.equal(results.every(r => r.status === 0) ? 0 : results.find(r => r.status !== 0).status, expected);
  }
});
