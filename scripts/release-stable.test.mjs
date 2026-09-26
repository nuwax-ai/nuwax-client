import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('stable compatibility entry forwards unchanged arguments to the Node release state machine', () => {
  const wrapper = readFileSync(new URL('./release-stable.sh', import.meta.url), 'utf8');
  assert.match(wrapper, /exec node .*client\/release\.mjs.*--channel stable.*"\$@"/);
  assert.doesNotMatch(wrapper, /jq|curl|gh workflow|git tag/);
});
