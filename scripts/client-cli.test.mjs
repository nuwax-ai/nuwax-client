import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, main } from './client/cli.mjs';

test('CLI parses command-specific values and camelCase flags', () => {
  assert.deepEqual(parseArgs(['sub:update', '--nuwax=feat/example', '--no-push-dist']), {
    command: 'sub:update', options: { nuwax: 'feat/example', noPushDist: true },
  });
  assert.deepEqual(parseArgs(['dev', '--frontend', 'source', '--port', '3001']).options,
    { frontend: 'source', port: 3001 });
});
test('CLI refuses ignored or malformed flags before a release can mutate Git', () => {
  for (const argv of [['release', '--no-commit'], ['pack', '--push'], ['doctor', '--force'],
    ['dev', '--port', '0'], ['pack', '--frontend', 'other'], ['release', '--version'], ['dev', '--dry-run=true']]) {
    assert.throws(() => parseArgs(argv));
  }
});
test('CLI refuses contradictory update flags before acquiring a lock', async () => {
  await assert.rejects(main(['sub:update', '--no-commit', '--push']), /cannot be combined/);
  await assert.rejects(main(['sub:update', '--no-build', '--force-build']), /cannot be combined/);
});
