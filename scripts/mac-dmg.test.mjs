import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createDmgEnvironment, stageDmgArgs } from './mac-dmg.mjs';

const stage = ['create', '-srcfolder', '/signed path/Nuwax.app', '-format', 'UDRW', '-quiet', '-fs', 'HFS+', '-fsargs', '-c c=64,a=16,e=16', '/tmp/stage.dmg'];

test('only Intel HFS+ staging images change filesystem; source and other hdiutil calls are preserved', () => {
  const result = stageDmgArgs(stage, 'x64');
  assert.equal(result[result.indexOf('-fs') + 1], 'APFS');
  assert.ok(!result.includes('-fsargs'));
  assert.ok(!result.includes('-c c=64,a=16,e=16'));
  assert.equal(result[result.indexOf('-srcfolder') + 1], '/signed path/Nuwax.app');
  assert.equal(stage[stage.indexOf('-fs') + 1], 'HFS+');
  assert.deepEqual(stageDmgArgs(stage, 'arm64'), stage);
  for (const args of [
    ['convert', '/tmp/input.dmg', '-format', 'UDZO', '-imagekey', 'zlib-level=1'],
    ['attach', '-plist', '/tmp/input.dmg'],
    ['create', '-size', '20m', '-fs', 'HFS+', '/tmp/other.dmg'],
  ]) assert.deepEqual(stageDmgArgs(args, 'x64'), args);
});

test('temporary wrapper prepends PATH, logs phase timings and always removes its files', () => {
  const logs = [];
  const scope = createDmgEnvironment({ arch: 'x64', env: { PATH: '/usr/bin:/bin', PRIVATE_VALUE: 'never-log' }, log: text => logs.push(text) });
  const wrapper = path.join(scope.directory, 'hdiutil');
  assert.equal(scope.env.PATH.split(path.delimiter)[0], scope.directory);
  assert.equal(scope.env.PRIVATE_VALUE, 'never-log');
  assert.ok(fs.statSync(wrapper).mode & 0o100);
  fs.writeFileSync(scope.env.NUWAX_DMG_TRACE_FILE, [
    { id: '1', phase: 'create', event: 'start', filesystem: 'APFS', format: 'UDRW' },
    { id: '1', phase: 'create', event: 'end', filesystem: 'APFS', format: 'UDRW', elapsedMs: 1250, status: 0 },
    { id: '2', phase: 'convert', event: 'end', format: 'UDZO', elapsedMs: 2500, status: 0 },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  try { scope.finish(true); } finally { scope.cleanup(); }
  assert.ok(logs.some(text => /create.*APFS.*1\.25s/.test(text)));
  assert.ok(logs.some(text => /convert.*2\.50s/.test(text)));
  assert.ok(logs.every(text => !text.includes('never-log')));
  assert.equal(fs.existsSync(scope.directory), false);
});

test('successful Intel packaging must prove it used an APFS staging image', () => {
  const scope = createDmgEnvironment({ arch: 'x64', log: () => {} });
  try {
    assert.throws(() => scope.finish(true), /APFS staging/);
    assert.doesNotThrow(() => scope.finish(false));
    fs.writeFileSync(scope.env.NUWAX_DMG_TRACE_FILE, 'interrupted trace');
    assert.doesNotThrow(() => scope.finish(false));
    assert.throws(() => scope.finish(true), /Cannot verify APFS/);
  } finally { scope.cleanup(); }
});

test('real wrapper preserves plist stdout and creates a mountable APFS image', { skip: process.platform !== 'darwin' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-dmg-native-'));
  const scope = createDmgEnvironment({ arch: 'x64', log: () => {} });
  t.after(() => { scope.cleanup(); fs.rmSync(temp, { recursive: true, force: true }); });
  const source = path.join(temp, 'source with spaces'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '内容.txt'), 'signed payload fixture\n');
  const image = path.join(temp, 'stage.dmg');
  const mount = path.join(temp, 'mount'); fs.mkdirSync(mount);
  const run = args => {
    const result = spawnSync(path.join(scope.directory, 'hdiutil'), args, { env: scope.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(['create', '-srcfolder', source, '-volname', 'Nuwax Dmg Fixture', '-format', 'UDRW', '-fs', 'HFS+', '-fsargs', '-c c=64,a=16,e=16', '-quiet', image]);
  let attached = false;
  try {
    const plist = run(['attach', '-readonly', '-nobrowse', '-plist', '-mountpoint', mount, image]);
    attached = true;
    assert.match(plist, /^<\?xml/);
    assert.ok(!plist.includes('[mac-dmg]'));
    assert.equal(fs.readFileSync(path.join(mount, '内容.txt'), 'utf8'), 'signed payload fixture\n');
    const info = spawnSync('/usr/sbin/diskutil', ['info', '-plist', mount], { encoding: 'utf8' });
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /<string>apfs<\/string>/i);
  } finally { if (attached) run(['detach', mount]); }
  scope.finish(true);
});
