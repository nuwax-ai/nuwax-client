const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { installChildProcessTracking } = require('./child-process-tracking.cjs');

test('tracking preserves callback, custom promisify, errors and Promise.child', async () => {
  const tracked = [];
  const original = childProcess.execFile;
  const descriptors = Object.getOwnPropertyDescriptors(original);
  let closing = false;
  const tracker = installChildProcessTracking(childProcess, {
    onChild: (child, method) => tracked.push({ child, method }), isClosing: () => closing,
  });
  try {
    assert.deepEqual(Reflect.ownKeys(childProcess.execFile), Reflect.ownKeys(original));
    const custom = Object.getOwnPropertyDescriptor(childProcess.execFile, promisify.custom);
    for (const field of ['writable', 'enumerable', 'configurable']) assert.equal(custom[field], descriptors[promisify.custom][field]);
    const command = 'process.stdout.write("stdout-result");process.stderr.write("stderr-result")';
    const callbackResult = await new Promise((resolve, reject) => childProcess.execFile(process.execPath, ['-e', command],
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
    assert.deepEqual(callbackResult, { stdout: 'stdout-result', stderr: 'stderr-result' });

    const promised = promisify(childProcess.execFile)(process.execPath, ['-e', command]);
    assert.ok(promised.child?.pid, 'custom Promise.child must remain available');
    assert.deepEqual(await promised, callbackResult, 'resource probes rely on stdout/stderr object');
    assert.equal(tracked.filter(entry => entry.child === promised.child).length, 1);

    const failed = promisify(childProcess.execFile)(process.execPath, ['-e', command + ';process.exit(7)']);
    await assert.rejects(failed, error => error.code === 7 && error.stdout === 'stdout-result' && error.stderr === 'stderr-result');

    const shell = promisify(childProcess.exec)(process.platform === 'win32' ? 'echo shell-result' : 'printf shell-result');
    assert.ok(shell.child?.pid);
    const shellOutput = await shell;
    assert.equal(shellOutput.stdout.trim(), 'shell-result'); assert.equal(shellOutput.stderr, '');
    assert.equal(tracked.filter(entry => entry.child === shell.child).length, 1, 'nested exec/execFile must not double-register');

    closing = true;
    assert.throws(() => childProcess.execFile(process.execPath, ['-e', '']), /shutting down/);
    assert.throws(() => promisify(childProcess.execFile)(process.execPath, ['-e', '']), /shutting down/);
  } finally { tracker.restore(); }
  assert.equal(childProcess.execFile, original);
});
