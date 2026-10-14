import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from './client/core.mjs';
import { inspectCaptureWindowResource, prepareCaptureWindowResources, readCaptureWindowSourceLock } from './client/capture-window-resources.mjs';

const locked = readCaptureWindowSourceLock(path.resolve(import.meta.dirname, '..'));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-window-resource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = structuredClone(locked), archives = new Map(), binaries = new Map();
  const temporary = path.join(root, 'fixtures'); fs.mkdirSync(temporary);
  for (const [name, entry] of Object.entries({ source: lock.source, ...lock.targets })) {
    const file = path.join(temporary, entry.archive); fs.writeFileSync(file, `${name} locked archive`);
    entry.sha256 = core.fileHash(file); archives.set(entry.url, file);
    if (name !== 'source') {
      const binary = path.join(temporary, name); fs.writeFileSync(binary, `${name} native binary`);
      entry.binarySha256 = core.fileHash(binary); binaries.set(entry.binary, binary);
    }
  }
  fs.mkdirSync(path.join(root, 'third-party')); core.atomicJson(path.join(root, 'third-party/capture-window-sources.json'), lock);
  const calls = [];
  const tools = { ...core, run: async (command, args) => {
    calls.push({ command, args });
    if (command === 'curl') fs.copyFileSync(archives.get(args.at(-3)), args.at(-1));
    else if (command === 'tar') {
      const member = args.at(-1), output = path.join(args[3], member); fs.mkdirSync(path.dirname(output), { recursive: true });
      if (member.endsWith('LICENSE.txt')) fs.writeFileSync(output, 'Permission is hereby granted, free of charge, to any person obtaining a copy');
      else fs.copyFileSync(binaries.get(member), output);
    } else assert.fail(`unexpected execution: ${command}`);
    return { status: 0, stdout: '', stderr: '' };
  } };
  return { root, lock, calls, tools, binaries, archives };
}

test('Koffi source and all six native targets have fixed registry archives and binary hashes', () => {
  assert.equal(locked.version, '3.3.3');
  assert.deepEqual(Object.keys(locked.targets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  for (const [target, entry] of Object.entries(locked.targets)) {
    assert.equal(entry.package, `@koromix/koffi-${target}`);
    assert.match(entry.url, /-3\.3\.3\.tgz$/); assert.match(entry.binarySha256, /^[a-f0-9]{64}$/);
  }
});

test('preparation selects only the requested target and keeps the encoder untouched', async t => {
  const f = fixture(t);
  for (const target of Object.keys(f.lock.targets)) {
    const [platform, arch] = target.split('-'), dir = path.join(f.root, 'resources/capture', target);
    fs.mkdirSync(dir, { recursive: true }); const encoder = path.join(dir, 'ffmpeg'); fs.writeFileSync(encoder, 'existing encoder');
    await prepareCaptureWindowResources(f.root, { platform, arch, tools: f.tools });
    assert.ok(inspectCaptureWindowResource(f.root, { platform, arch }));
    assert.equal(fs.readFileSync(encoder, 'utf8'), 'existing encoder');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['ffmpeg', 'koffi.json', 'koffi.node']);
  }
  const before = f.calls.filter(call => call.command === 'curl').length;
  await prepareCaptureWindowResources(f.root, { platform: 'darwin', arch: 'arm64', tools: f.tools });
  assert.equal(f.calls.filter(call => call.command === 'curl').length, before);
  assert.ok(fs.existsSync(path.join(f.root, 'third-party/licenses/koffi.txt')));
});

test('changed binary, downloaded archive and extracted native payload are refused', async t => {
  const f = fixture(t), options = { platform: 'darwin', arch: 'arm64', tools: f.tools };
  await prepareCaptureWindowResources(f.root, options);
  const dir = path.join(f.root, 'resources/capture/darwin-arm64'); fs.appendFileSync(path.join(dir, 'koffi.node'), 'tampered');
  assert.equal(inspectCaptureWindowResource(f.root, options), null);
  await assert.rejects(prepareCaptureWindowResources(f.root, options), /Refusing to overwrite/);
  const downloaded = fixture(t); fs.appendFileSync(downloaded.archives.get(downloaded.lock.source.url), 'tampered');
  await assert.rejects(prepareCaptureWindowResources(downloaded.root, { ...options, tools: downloaded.tools }), /SHA256 mismatch/);
  const extracted = fixture(t); fs.appendFileSync(extracted.binaries.get(extracted.lock.targets['darwin-arm64'].binary), 'tampered');
  await assert.rejects(prepareCaptureWindowResources(extracted.root, { ...options, tools: extracted.tools }), /payload failed verification/);
});
