import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { TASKS, checkFixture, checkNative, summarize, buildAgentConfig, failureCategory, cancellable, observationArgs } from './bench/real-core.mjs';
import { modelTotals, startModelProxy } from './bench/real-model.mjs';
import { startFixture } from './bench/real-fixture.mjs';
import { parseArgs } from './bench/real-run.mjs';
import { AcpPeer, probeAgentStartup } from './bench/real-acp.mjs';
import { runtimeEnvironment } from './bench/real-host.mjs';

test('failed agent startup closes without waiting for a nonexistent process exit', { timeout: 1500 }, async () => {
  const peer = new AcpPeer('nuwax-cu-benchmark-command-that-does-not-exist', [], {}, () => {});
  await assert.rejects(peer.request('initialize', {}), /agentStartFailed/);
  await peer.close();
});

test('startup preflight accepts a real version, bounds a hung process and omits failure output', { timeout: 3000 }, async () => {
  const valid = await probeAgentStartup(process.execPath);
  assert.equal(valid.passed, true);
  assert.equal(valid.version, process.versions.node);
  const failed = await probeAgentStartup(process.execPath, { args: ['-e', 'console.error("private startup content");process.exit(17)'] });
  assert.deepEqual(failed, { passed: false, exitCode: 17, reason: 'agentStartupFailed' });
  const hung = await probeAgentStartup(process.execPath, { args: ['-e', 'setInterval(()=>{},1000)'], timeout: 100 });
  assert.deepEqual(hung, { passed: false, exitCode: null, reason: 'agentStartupTimeout' });
});

test('helper and agent child environments omit provider credentials and inherited agent configuration', () => {
  assert.deepEqual(runtimeEnvironment({ PATH: '/tools', SystemRoot: 'C:\\Windows', CUA_MODEL_API_KEY: 'private',
    CUA_MODEL_BASE_URL: 'private-endpoint', OPENAI_API_KEY: 'private', OPENCODE_CONFIG_CONTENT: 'private' }),
  { PATH: '/tools', SystemRoot: 'C:\\Windows' });
});

test('operator cancellation does not wait for a stalled engine and consumes late rejection', async () => {
  const controller = new AbortController(); let fail;
  const work = new Promise((_, reject) => { fail = reject; });
  const result = cancellable(work, controller.signal);
  controller.abort(); await assert.rejects(result, /runCancelled/);
  fail(new Error('lateEngineExit'));
  await assert.rejects(cancellable(Promise.resolve('late'), controller.signal), /runCancelled/);
});

test('AX diagnostic disables screenshots on every observation alias without changing hybrid or actions', () => {
  for (const tool of ['get_window_state','get_desktop_state','get_accessibility_tree']) {
    assert.equal(observationArgs(tool, { include_screenshot: true }, 'ax').include_screenshot, false);
    assert.deepEqual(observationArgs(tool, {}, 'hybrid'), {});
  }
  assert.deepEqual(observationArgs('click', { element_index: 2 }, 'ax'), { element_index: 2 });
});

test('independent oracle rejects claimed completion, partial edits and wrong selection', () => {
  const task = TASKS[0];
  assert.equal(checkFixture(task, { completed: true }), false);
  assert.equal(checkFixture(task, { ...task.expected, name: '林' }), false);
  assert.equal(checkFixture(task, { ...task.expected }), true);
  assert.equal(checkFixture(task, { ...task.expected, wrong: true }), false);
  const scroll = TASKS.find(t => t.id === 'F04');
  assert.equal(checkFixture(scroll, { picked: 28 }), false);
  assert.equal(checkFixture(scroll, { picked: 28, scrolled: true, visible: false }), false);
  assert.equal(checkFixture(scroll, { ...scroll.expected }), true);
  const native = TASKS.at(-1);
  assert.equal(checkNative(native, { ok: true, result: { content: [{ text: native.expected.text }], structuredContent: { elements: [] } } }), false);
  assert.equal(checkNative(native, { ok: true, result: { structuredContent: { elements: [{ value: native.expected.text + '\n' }] } } }), true);
});

test('coverage denominator retains blocked and missing runs; failures are charged to successful-task cost', () => {
  const results = [{ status: 'passed', interventions: 0, durationMs: 20, costUsd: 1 }, { status: 'failed', failure: 'timeout', durationMs: 100, costUsd: 2 }, { status: 'blocked', failure: 'environment', costUsd: null }];
  const summary = summarize(results, 5);
  assert.equal(summary.unassistedSuccessRate, .2);
  assert.equal(summary.completed, false);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.durationMsP95, 100);
  assert.equal(summary.costPerSuccessfulTaskUsd, null);
  assert.equal(summarize(results.slice(0,2), 2).costPerSuccessfulTaskUsd, 3);
});

test('usage unavailable or unpriced is unknown instead of a free successful task', () => {
  assert.equal(modelTotals([], { input: 0, output: 0 }).costUsd, null);
  assert.equal(modelTotals([{ images: 1, durationMs: 1, finished: true, usage: { input: 100, output: 50 } }]).costUsd, null);
  const totals = modelTotals([{ images: 1, durationMs: 1, finished: true, usage: { input: 1000000, output: 500000 } }], { input: 2, output: 4 });
  assert.equal(totals.costUsd, 4);
  assert.equal(totals.imageInputs, 1);
});

test('agent tools and credentials remain confined to the instrumented Computer Use route', () => {
  const config = buildAgentConfig({ model: 'test-vision', baseUrl: 'http://127.0.0.1:1234/v1', proxyToken: 'test-local-token' });
  assert.deepEqual(config.tools, { '*': false, 'cua_*': true });
  assert.deepEqual(config.permission, { '*': 'deny', 'cua_*': 'allow' });
  assert.equal(config.provider['cua-bench'].options.apiKey, 'test-local-token');
  assert.throws(() => buildAgentConfig({ model: 'test', baseUrl: 'http://127.0.0.1/v1' }), /modelProxyTokenRequired/);
  assert.equal(failureCategory({ reason: 'boundaryViolation' }), 'control-boundary');
  assert.throws(() => parseArgs(['--repeat','0']));
  assert.throws(() => parseArgs(['--tasks','F01','--force']));
  assert.throws(() => parseArgs(['--input-usd-per-million','1']));
  assert.equal(parseArgs([]).mode, 'background');
});

test('fixture tracks observable submission independently of agent text', async () => {
  const fixture = await startFixture(TASKS[0]);
  try {
    assert.equal(checkFixture(TASKS[0], fixture.state), false);
    const res = await fetch(fixture.url + '/state', { method: 'POST', body: JSON.stringify({ ...TASKS[0].expected, secret: 'not retained' }) });
    assert.equal(res.status, 200);
    assert.equal(checkFixture(TASKS[0], fixture.state), true);
    assert.equal(Object.hasOwn(fixture.state, 'secret'), false);
  } finally { await fixture.close(); }
});

test('model instrumentation counts final streamed usage once and does not retain content or credentials', async () => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    received = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"private model content"}}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'); res.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = await startModelProxy({ baseUrl: `http://127.0.0.1:${upstream.address().port}/provider`, apiKey: 'test-private-key', model: 'vision-test' });
  try {
    assert.equal((await fetch(proxy.url + '/chat/completions', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(proxy.url + '/models', { headers: { authorization: 'Bearer local-benchmark-only' } })).status, 401);
    const response = await fetch(proxy.url + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ model: 'vision-test', stream: true, messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,private' } }] }] }) });
    await response.text();
    assert.equal(received.path, '/provider/chat/completions');
    assert.equal(received.auth, 'Bearer test-private-key');
    assert.equal(received.body.stream_options.include_usage, true);
    assert.equal(modelTotals(proxy.records).outputTokens, 2);
    assert.equal(proxy.records[0].images, 1);
    assert.doesNotMatch(JSON.stringify(proxy.records), /private|test-private-key|image_url/);
  } finally { await proxy.close(); await new Promise(resolve => upstream.close(resolve)); }
});
