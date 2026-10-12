import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureAttachmentController, readCaptureFile } from './im-native-capture.ts';

const success = (bytes, overrides = {}) => ({
  success: true, resultId: 'result123', mime: 'video/webm', bytes,
  width: 800, height: 600, qualityUsed: 'high', hdrToneMapped: false, ...overrides,
});

test('多块读取按真实长度推进，保留 MIME、扩展名和字节数，最后释放', async () => {
  const bytes = 5 * 1024 * 1024 + 7;
  const requests = []; const released = [];
  const file = await readCaptureFile({
    async readChunk(id, offset, length) { requests.push([id, offset, length]); return new Uint8Array(length).buffer; },
    async release(id) { released.push(id); },
  }, success(bytes), bytes);
  assert.equal(file.size, bytes); assert.equal(file.type, 'video/webm');
  assert.match(file.name, /^录屏-\d+\.webm$/);
  assert.deepEqual(requests, [['result123', 0, 4194304], ['result123', 4194304, bytes - 4194304]]);
  assert.deepEqual(released, ['result123']);
});

for (const [name, part] of [['null', null], ['短块', new ArrayBuffer(2)]]) {
  test(`拒绝${name}失效结果并释放，不返回空文件`, async () => {
    let released = 0;
    await assert.rejects(readCaptureFile({
      async readChunk() { return part; }, async release() { released++; },
    }, success(8), 100), (error) => error.code === 'expired');
    assert.equal(released, 1);
  });
}

for (const result of [success(101), success(99, { exceedsMaxBytes: true })]) {
  test('超限在分块读取前阻止并释放结果', async () => {
    let reads = 0; let released = 0;
    await assert.rejects(readCaptureFile({
      async readChunk() { reads++; return new ArrayBuffer(1); }, async release() { released++; },
    }, result, 100), (error) => error.code === 'too-large');
    assert.equal(reads, 0); assert.equal(released, 1);
  });
}

test('未知 MIME 拒绝并释放，释放失败不掩盖原始读取错误', async () => {
  await assert.rejects(readCaptureFile({
    async readChunk() { throw new Error('should not read'); },
    async release() { throw new Error('document ended'); },
  }, success(8, { mime: 'text/html' }), 100), (error) => error.code === 'invalid-result');
});

function deferred() {
  let resolve;
  return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) };
}
function composerFixture() {
  const recording = deferred();
  const calls = { record: [], screenshot: [], reads: [], released: [], attachments: [], busy: [], off: 0, cancel: 0 };
  let current = 'chat-A', valid = true;
  const bridge = {
    async getCapabilities() { return { available: true, formats: { still: ['png', 'jpeg'], video: ['mp4', 'webm'], gif: true } }; },
    async record(options) { calls.record.push(options); return recording.promise; },
    async screenshot(options) { calls.screenshot.push(options); return success(8, { mime: 'image/png' }); },
    onStateChange() { return () => calls.off++; },
    async readChunk(id, offset, length) { calls.reads.push([id, offset, length]); return new ArrayBuffer(length); },
    async release(id) { calls.released.push(id); }, async cancel() { calls.cancel++; },
  };
  const controller = createCaptureAttachmentController({
    getTarget: () => ({ conversationId: current, draftRevision: 1 }),
    isTargetValid: () => valid,
    getMaxUploadBytes: () => 1024,
    addPending(target, files) { calls.attachments.push({ target, files }); },
    getCapture: () => bridge, onBusyChange: busy => calls.busy.push(busy),
  });
  return { controller, bridge, calls, recording, switchChat: () => { current = 'chat-B'; }, invalidate: () => { valid = false; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const [output, mime] of [['mp4', 'video/mp4'], ['webm', 'video/webm'], ['gif', 'image/gif']]) {
  test(`IM 菜单发起 ${output}：编码完成后回填原会话草稿，并释放句柄`, async () => {
    const f = composerFixture();
    const pending = f.controller.run({ kind: 'record', options: { output } });
    await tick();
    assert.equal(f.calls.attachments.length, 0);
    assert.deepEqual(f.calls.record, [{ output }]);
    f.switchChat(); // 已切换可见会话，仍只能回填 chat-A。
    f.recording.resolve(success(8, { mime, durationMs: 2000 }));
    assert.deepEqual(await pending, { status: 'attached' });
    assert.equal(f.calls.attachments.length, 1);
    assert.equal(f.calls.attachments[0].target.conversationId, 'chat-A');
    assert.equal(f.calls.attachments[0].files[0].type, mime);
    assert.equal(f.calls.attachments[0].files[0].size, 8);
    assert.deepEqual(f.calls.released, ['result123']); assert.equal(f.calls.off, 1);
    assert.deepEqual(f.calls.busy, [true, false]);
  });
}

test('同一菜单控制器的重复点击返回 busy，取消不生成附件', async () => {
  const f = composerFixture();
  const pending = f.controller.run({ kind: 'record', options: { output: 'mp4' } });
  assert.deepEqual(await f.controller.run({ kind: 'screenshot' }), { status: 'failed', code: 'busy' });
  f.recording.resolve({ success: false, code: 'canceled' });
  assert.deepEqual(await pending, { status: 'canceled' });
  assert.equal(f.calls.attachments.length, 0); assert.equal(f.calls.screenshot.length, 0);
  assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.off, 1);
});

for (const stage of ['recording', 'reading', 'unmount']) {
  test(`${stage} 中草稿失效或 IM 卸载：不回填，仍释放且不取消其他入口`, async () => {
    const f = composerFixture();
    if (stage === 'reading') f.bridge.readChunk = async () => { f.invalidate(); return new ArrayBuffer(8); };
    const pending = f.controller.run({ kind: 'record', options: { output: 'mp4' } });
    await tick();
    if (stage === 'recording') f.invalidate();
    if (stage === 'unmount') f.controller.dispose();
    f.recording.resolve(success(8, { mime: 'video/mp4' }));
    assert.deepEqual(await pending, { status: 'invalid-target' });
    assert.equal(f.calls.attachments.length, 0); assert.equal(f.calls.off, 1);
    assert.deepEqual(f.calls.released, ['result123']); assert.equal(f.calls.cancel, 0);
  });
}

test('超限录制不会进入附件区，编码失败不会触发浏览器降级或截图', async () => {
  const f = composerFixture();
  f.recording.resolve(success(1025));
  assert.deepEqual(await f.controller.run({ kind: 'record', options: { output: 'webm' } }), { status: 'failed', code: 'too-large' });
  assert.equal(f.calls.attachments.length, 0); assert.equal(f.calls.reads.length, 0);
  f.bridge.record = async () => ({ success: false, code: 'failed' });
  assert.deepEqual(await f.controller.run({ kind: 'record', options: { output: 'mp4' } }), { status: 'failed', code: 'failed' });
  assert.equal(f.calls.screenshot.length, 0);
});

test('截图也复用同一会话附件入口；缺格式在发起前返回 unavailable', async () => {
  const f = composerFixture();
  assert.deepEqual(await f.controller.run({ kind: 'screenshot', options: { format: 'png' } }), { status: 'attached' });
  assert.equal(f.calls.attachments[0].files[0].type, 'image/png');
  f.bridge.getCapabilities = async () => ({ available: true, formats: { still: ['png'], video: [], gif: false } });
  assert.deepEqual(await f.controller.run({ kind: 'record', options: { output: 'mp4' } }), { status: 'unavailable' });
  assert.equal(f.calls.record.length, 0);
});
