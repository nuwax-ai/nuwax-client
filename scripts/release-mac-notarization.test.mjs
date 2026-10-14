import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { notarizeSignedApp, packageNotarizedApp, macAppPaths, transientAppleError } from './release-mac-notarization.mjs';

const id = '36bad44d-20b0-465a-a9f2-3a114ee0b282';
const cdhash = 'a'.repeat(40);
function fixture(t, behavior = () => undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-notary-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], waits = [];
  const tools = { run: async (command, args, options) => {
    calls.push({ command, args, options });
    const supplied = behavior(command, args, calls);
    if (supplied) return supplied;
    if (command === 'codesign' && args[0] === '-d') return { status: 0, stderr: `CDHash=${cdhash}\nTeamIdentifier=TEAM1234\nAuthority=Developer ID Application: test\n` };
    if (args[0] === 'notarytool') return { status: 0, stdout: JSON.stringify({ id, status: 'Accepted' }) };
    return { status: 0, stdout: '', stderr: '' };
  } };
  const options = { app: '/signed path/Nuwax.app', stateFile: path.join(root, 'state.json'), auth: { key: '/not-read.p8', keyId: 'KEY1234', issuer: 'issuer' },
    tools, wait: async ms => waits.push(ms) };
  return { root, calls, waits, tools, options };
}

test('network errors retry the same submitted app and ticket; credentials stay out of persisted state', async t => {
  let infos = 0, staples = 0;
  const f = fixture(t, (_command, args) => {
    if (args[1] === 'info' && infos++ === 0) return { status: 1, stderr: 'NSURLErrorDomain Code=-1009 No network route' };
    if (args[1] === 'staple' && staples++ < 2) return { status: 68, stderr: 'NSURLErrorDomain Code=-1005 The network connection was lost.' };
  });
  assert.equal(await notarizeSignedApp(f.options), id);
  assert.equal(f.calls.filter(c => c.args[1] === 'submit').length, 1);
  assert.ok(f.calls.filter(c => c.args[1] === 'info').every(c => c.args[2] === id));
  assert.deepEqual(f.waits, [15000, 15000, 30000]);
  const state = fs.readFileSync(f.options.stateFile, 'utf8');
  assert.equal(JSON.parse(state).ticketValidated, true);
  assert.doesNotMatch(state, /KEY1234|issuer|not-read/);
});

test('a failed staple preserves the Accepted submission and resume never uploads the app again', async t => {
  const f = fixture(t, (_command, args) => args[1] === 'staple' ? { status: 68, stderr: 'The network connection was lost.' } : undefined);
  await assert.rejects(notarizeSignedApp(f.options), /ticket staple failed/);
  assert.equal(f.calls.filter(c => c.args[1] === 'staple').length, 5);
  assert.equal(JSON.parse(fs.readFileSync(f.options.stateFile)).status, 'Accepted');
  const resumed = fixture(t);
  await notarizeSignedApp({ ...resumed.options, stateFile: f.options.stateFile });
  assert.equal(resumed.calls.filter(c => c.args[1] === 'submit').length, 0);
  assert.equal(resumed.calls.filter(c => c.command === 'ditto').length, 0);
});

test('Invalid, mismatched submission ID and permanent ticket errors fail closed', async t => {
  for (const scenario of ['invalid', 'wrong-id', 'ticket']) {
    const f = fixture(t, (_command, args) => {
      if (args[1] === 'info' && scenario !== 'ticket') return { status: 0, stdout: JSON.stringify({ id: scenario === 'wrong-id' ? 'other' : id, status: 'Invalid' }) };
      if (args[1] === 'staple') return { status: 68, stderr: 'ticket signature is invalid' };
    });
    await assert.rejects(notarizeSignedApp(f.options));
    assert.equal(f.waits.length, 0);
    assert.equal(f.calls.filter(c => c.args[1] === 'staple').length, scenario === 'ticket' ? 1 : 0);
    assert.equal(JSON.parse(fs.readFileSync(f.options.stateFile)).ticketValidated, undefined);
  }
});

test('bad signatures, ad-hoc identity and changed resume CDHash never submit', async t => {
  const bad = fixture(t, (command, args) => command === 'codesign' && args[0] === '--verify' ? { status: 1, stderr: 'invalid signature' } : undefined);
  await assert.rejects(notarizeSignedApp(bad.options), /signature verification/);
  assert.equal(bad.calls.length, 1);
  const adhoc = fixture(t, (command, args) => command === 'codesign' && args[0] === '-d' ? { status: 0, stderr: `CDHash=${cdhash}\nSignature=adhoc\n` } : undefined);
  await assert.rejects(notarizeSignedApp(adhoc.options), /Developer ID/);
  const changed = fixture(t);
  fs.writeFileSync(changed.options.stateFile, JSON.stringify({ schema: 1, cdhash: 'b'.repeat(40), team: 'TEAM1234', id }));
  await assert.rejects(notarizeSignedApp(changed.options), /different signed app/);
  for (const f of [bad, adhoc, changed]) assert.equal(f.calls.filter(c => c.args[0] === 'notarytool').length, 0);
});

test('pending processing is bounded and preserves the ID for a later resume', async t => {
  const f = fixture(t, (_command, args) => args[1] === 'info' ? { status: 0, stdout: JSON.stringify({ id, status: 'In Progress' }) } : undefined);
  await assert.rejects(notarizeSignedApp({ ...f.options, maxPolls: 2 }), /polling limit/);
  assert.equal(f.calls.filter(c => c.args[1] === 'info').length, 2);
  assert.deepEqual(f.waits, [30000]);
  assert.equal(JSON.parse(fs.readFileSync(f.options.stateFile)).id, id);
});

test('packaging requires a valid ticket and uses the app without another signing pass', async t => {
  const f = fixture(t);
  await packageNotarizedApp({ client: '/client', app: f.options.app, arch: 'x64', builderCli: '/builder.js', tools: f.tools, wait: f.options.wait });
  const packaged = f.calls.find(c => c.command === process.execPath);
  assert.deepEqual(packaged.args.slice(0, 4), ['/builder.js', '--prepackaged', '/signed path/Nuwax.app', '--mac']);
  assert.ok(packaged.args.includes('--x64'));
  assert.ok(f.calls.findIndex(c => c.args[1] === 'validate') < f.calls.indexOf(packaged));
  assert.equal(f.calls.filter(c => c.args[1] === 'validate').length, 2);
  const denied = fixture(t, (_command, args) => args[1] === 'validate' ? { status: 65, stderr: 'invalid ticket' } : undefined);
  await assert.rejects(packageNotarizedApp({ client: '/client', app: denied.options.app, arch: 'x64', builderCli: '/builder.js', tools: denied.tools }), /ticket validation/);
  assert.equal(denied.calls.some(c => c.command === process.execPath), false);
});

test('state is beside the app, outside public asset uploads; both architectures resolve the versioned output', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: '3.0.14-beta.6', build: { directories: { output: 'release/${version}' } } }));
  for (const arch of ['x64', 'arm64']) {
    fs.mkdirSync(path.join(f.root, 'release/3.0.14-beta.6', arch === 'x64' ? 'mac' : 'mac-arm64', 'Nuwax.app'), { recursive: true });
    const result = macAppPaths(f.root, arch);
    assert.equal(path.dirname(result.stateFile), path.dirname(result.app));
    assert.notEqual(path.dirname(result.stateFile), result.output);
  }
  assert.throws(() => macAppPaths(f.root, 'ia32'), /architecture/);
  assert.equal(transientAppleError('HTTP 401 Unauthorized'), false);
  assert.equal(transientAppleError('The staple and validate action failed! Error 68. invalid ticket'), false);
});

test('distribution never accepts an app whose signature changes while generating archives', async t => {
  let packaged = false;
  const f = fixture(t, (command, args) => {
    if (command === process.execPath) { packaged = true; return { status: 0 }; }
    if (command === 'codesign' && args[0] === '-d' && packaged) {
      return { status: 0, stderr: `CDHash=${'b'.repeat(40)}\nTeamIdentifier=TEAM1234\n` };
    }
  });
  await assert.rejects(packageNotarizedApp({ client: '/client', app: f.options.app, arch: 'arm64', builderCli: '/builder.js', tools: f.tools }), /changed the signed app/);
});

test('an unchanged app with a validated ticket resumes without re-submitting or re-stapling', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.options.stateFile, JSON.stringify({ schema: 1, id, cdhash, team: 'TEAM1234', status: 'Accepted', ticketValidated: true }));
  await notarizeSignedApp(f.options);
  assert.equal(f.calls.filter(c => c.args[0] === 'notarytool').length, 0);
  assert.equal(f.calls.filter(c => c.args[1] === 'staple').length, 0);
  assert.equal(f.calls.filter(c => c.args[1] === 'validate').length, 1);
});
