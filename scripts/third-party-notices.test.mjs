import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildNotices,
  classifyLicense,
  collectNpmClosure,
  detectLicense,
  inspectFfmpegConfiguration,
  normalizeLicenseField,
  parseFfmpegConfiguration,
  writeNotices,
  shippedResourcePaths,
  generateThirdPartyNotices,
} from './client/third-party-notices.mjs';
import { generateThirdPartyNotices as generatePackagedNotices } from './client/source-notices.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const APACHE = 'Apache License\n Version 2.0, January 2004';
const LGPL21 = 'GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999';
const GPL3 = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007';

test('vendored browser source and full license survive package resource filtering', (t) => {
  const root = tmp(t);
  write(path.join(root, 'third-party/vendor.txt'), MIT);
  write(path.join(root, 'third-party/manifest.json'), { schema: 1, npmRoots: [], resources: {} });
  write(path.join(root, 'third-party/source-components.json'), { schema: 1, components: {
    browser: { id: 'browser', name: 'Browser', version: 'fixed-sha', license: 'MIT', licenseFile: 'third-party/vendor.txt', sourceUrl: 'https://example.test/fixed-sha', modified: true, checkIntegrity: true },
  } });
  const result = generatePackagedNotices(root, { outDir: path.join(root, 'out'), resourcePaths: {}, strict: true });
  assert.equal(result.document.components[0].id, 'browser');
  assert.equal(result.document.components[0].modified, true);
  assert.equal(fs.readFileSync(path.join(root, 'out/licenses/browser.txt'), 'utf8'), MIT);
});

test('browser source notices do not alter native capture-only artifact bytes or admission', (t) => {
  const root = tmp(t);
  write(path.join(root, 'license.txt'), MIT);
  write(path.join(root, 'third-party/manifest.json'), { schema: 1, npmRoots: [], resources: { capture: {
    id: 'native-capture', name: 'Native capture', version: '1.0', license: 'MIT', licenseFile: 'license.txt', sourceUrl: 'https://example.test/capture',
  } } });
  write(path.join(root, 'third-party/source-components.json'), { intentionallyInvalid: true });
  const baseline = generateThirdPartyNotices(root, { outDir: path.join(root, 'native'), captureOnly: true, strict: true });
  const packaged = generatePackagedNotices(root, { outDir: path.join(root, 'packaged'), captureOnly: true, strict: true });
  assert.deepEqual(packaged.document, baseline.document);
  for (const file of ['third-party-notices.json', 'licenses/native-capture.txt']) assert.deepEqual(fs.readFileSync(path.join(root, 'native', file)), fs.readFileSync(path.join(root, 'packaged', file)));
});

test('detectLicense recognises common license texts and refuses to guess', () => {
  assert.equal(detectLicense(MIT), 'MIT');
  assert.equal(detectLicense(MIT.replaceAll(' ', '\n  ')), 'MIT');
  assert.equal(detectLicense(APACHE), 'Apache-2.0');
  assert.equal(detectLicense(LGPL21), 'LGPL-2.1');
  assert.equal(detectLicense(GPL3), 'GPL-3.0');
  assert.equal(detectLicense('GNU AFFERO GENERAL PUBLIC LICENSE Version 3'), 'AGPL-3.0');
  assert.equal(detectLicense('Redistribution and use in source and binary forms ... Neither the name of X'), 'BSD-3-Clause');
  assert.equal(detectLicense('Redistribution and use in source and binary forms ...'), 'BSD-2-Clause');
  assert.equal(detectLicense('This is free and unencumbered software released into the public domain.'), 'Unlicense');
  assert.equal(detectLicense('All rights reserved. Proprietary.'), null);
  assert.equal(detectLicense(''), null);
});

test('builder payload audit only includes shipped resources and selects native capture directory', () => {
  const payload = { extraResources: [{ from: 'resources/uv/bin', to: 'uv/bin' }, { from: '/commercial/resources/capture/darwin-arm64', to: 'capture/darwin-arm64' }, { from: 'src/shared/locales', to: 'locales' }], win: { extraResources: [{ from: 'resources/git', to: 'git' }] } };
  const mac = shippedResourcePaths(payload, '/base/client', 'darwin');
  assert.deepEqual(mac, { uv: '/base/client/resources/uv', capture: '/commercial/resources/capture/darwin-arm64' });
  assert.equal(shippedResourcePaths(payload, '/base/client', 'win32').git, '/base/client/resources/git');
  assert.ok(!Object.hasOwn(mac, 'sandbox-runtime'));
});

test('Windows capture thread runtime is audited only on Windows with complete source and license text', (t) => {
  const root = tmp(t);
  const source = 'fixed winpthreads source';
  const license = `${MIT}\nLockless Inc.\nRedistribution and use in source and binary forms`;
  write(path.join(root, 'winpthreads.tar.gz'), source);
  write(path.join(root, 'winpthreads.txt'), license);
  const runtime = { id: 'winpthreads', name: 'MinGW-w64 Winpthreads', platforms: ['win32'], usedBy: 'capture', license: 'MIT AND BSD-3-Clause-Clear', licenseFile: 'winpthreads.txt', sourceUrl: 'https://example.test/source', sourceFile: 'winpthreads.tar.gz', sourceArchive: 'sources/winpthreads.tar.gz', sourceSha256: createHash('sha256').update(source).digest('hex') };
  const run = (platform) => buildNotices({ root, platform, manifest: { resources: { capture: runtime } }, npmComponents: [] });
  assert.equal(classifyLicense(runtime.license), 'permissive');
  assert.deepEqual(run('darwin'), { components: [], problems: [] });
  const result = run('win32');
  assert.deepEqual(result.problems, []);
  assert.equal(result.components.length, 1);
  const out = path.join(root, 'out');
  writeNotices(result, out);
  assert.equal(fs.readFileSync(path.join(out, 'licenses/winpthreads.txt'), 'utf8'), license);
  assert.equal(fs.readFileSync(path.join(out, 'sources/winpthreads.tar.gz'), 'utf8'), source);
  fs.rmSync(path.join(root, 'winpthreads.txt'));
  assert.deepEqual(codes(run('win32')), ['MISSING_LICENSE_TEXT:winpthreads']);
  assert.deepEqual(run('darwin'), { components: [], problems: [] });
});

test('Linux OpenH264 redistribution includes its source and BSD text without claiming Cisco binary-module coverage', (t) => {
  const root = tmp(t);
  const repository = path.resolve(import.meta.dirname, '..');
  const entry = JSON.parse(fs.readFileSync(path.join(repository, 'third-party/manifest.json'), 'utf8')).resources.capture.components.find(component => component.id === 'openh264');
  assert.ok(entry);
  assert.equal(entry.license, 'BSD-2-Clause'); assert.deepEqual(entry.platforms, ['linux']);
  assert.match(entry.notes, /不是 Cisco 分发的二进制模块/);
  const license = fs.readFileSync(path.join(repository, entry.licenseFile), 'utf8');
  const source = 'source-locked OpenH264 fixture';
  write(path.join(root, entry.sourceFile), source);
  write(path.join(root, entry.licenseFile), license);
  entry.sourceSha256 = createHash('sha256').update(source).digest('hex');
  const run = platform => buildNotices({ root, platform, manifest: { resources: { capture: entry } }, npmComponents: [] });
  assert.deepEqual(run('win32'), { components: [], problems: [] });
  assert.deepEqual(run('darwin'), { components: [], problems: [] });
  const result = run('linux'); assert.deepEqual(result.problems, []);
  const out = path.join(root, 'out'); writeNotices(result, out);
  assert.equal(fs.readFileSync(path.join(out, 'licenses/openh264.txt'), 'utf8'), license);
  assert.equal(fs.readFileSync(path.join(out, entry.sourceArchive), 'utf8'), source);
  fs.appendFileSync(path.join(root, entry.sourceFile), 'altered');
  assert.deepEqual(codes(run('linux')), ['SOURCE_INTEGRITY:openh264']);
  fs.rmSync(path.join(root, entry.licenseFile));
  assert.deepEqual(codes(run('linux')), ['MISSING_LICENSE_TEXT:openh264', 'SOURCE_INTEGRITY:openh264']);
});

test('capture license and source archives must be real and hash verified; transitive libvpx is declared', (t) => {
  const f = noticesFixture(t, { files: { 'capture/ffmpeg': 'binary' } });
  const source = path.join(f.root, 'source.tgz');
  write(source, 'exact source bytes');
  const digest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  write(path.join(f.root, 'COPYING'), LGPL21);
  const entry = { id: 'ffmpeg', name: 'FFmpeg', version: '8.1.3', license: 'LGPL-2.1-or-later', licenseFile: 'COPYING', sourceUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz', sourceFile: 'source.tgz', sourceArchive: 'sources/source.tgz', sourceSha256: digest, usedBy: 'capture', components: [{ id: 'libvpx', name: 'libvpx', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/webmproject/libvpx', usedBy: 'capture' }] };
  f.manifest.resources = { capture: entry };
  const invalid = buildNotices({ ...f, npmComponents: [] });
  assert.deepEqual(codes(invalid), ['MISSING_LICENSE_TEXT:libvpx', 'SOURCE_INTEGRITY:libvpx']);
  entry.components = [];
  const valid = buildNotices({ ...f, npmComponents: [] });
  assert.deepEqual(codes(valid), []);
  const doc = writeNotices(valid, path.join(f.root, 'out'));
  assert.equal(doc.components[0].sourceArchive, 'sources/source.tgz');
  assert.equal(fs.readFileSync(path.join(f.root, 'out/sources/source.tgz'), 'utf8'), 'exact source bytes');
  assert.ok(!JSON.stringify(doc).includes(f.root));
  fs.appendFileSync(source, 'changed');
  assert.deepEqual(codes(buildNotices({ ...f, npmComponents: [] })), ['SOURCE_INTEGRITY:ffmpeg']);
});

test('strict generator stops before writing notices when an actual shipped resource is undeclared', (t) => {
  const f = noticesFixture(t, { files: { 'unverified/tool': 'bin' } });
  write(path.join(f.root, 'third-party/manifest.json'), { resources: {}, npmRoots: [] });
  assert.throws(() => generateThirdPartyNotices(f.root, { strict: true, resourcePaths: { unverified: path.join(f.resourcesDir, 'unverified') } }), /UNDECLARED_RESOURCE:unverified/);
  assert.equal(fs.existsSync(path.join(f.root, 'third-party/generated/third-party-notices.json')), false);
});

test('LGPL text is never mistaken for GPL or MIT', () => {
  assert.equal(detectLicense(`${LGPL21}\nPermission is hereby granted, free of charge, to any person obtaining a copy`), 'LGPL-2.1');
});

test('normalizeLicenseField handles string, object and legacy array forms', () => {
  assert.equal(normalizeLicenseField({ license: ' MIT ' }), 'MIT');
  assert.equal(normalizeLicenseField({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(normalizeLicenseField({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), 'MIT OR Apache-2.0');
  assert.equal(normalizeLicenseField({}), null);
  assert.equal(normalizeLicenseField(null), null);
});

test('classifyLicense: permissive, weak and strong copyleft, expressions, unknown', () => {
  assert.equal(classifyLicense('MIT'), 'permissive');
  assert.equal(classifyLicense('MIT OR Unlicense'), 'permissive');
  assert.equal(classifyLicense('(MIT AND CC-BY-3.0)'), 'permissive');
  assert.equal(classifyLicense('Apache-2.0 WITH LLVM-exception'), 'permissive');
  assert.equal(classifyLicense('LGPL-2.1'), 'weak-copyleft');
  assert.equal(classifyLicense('MPL-2.0'), 'weak-copyleft');
  assert.equal(classifyLicense('GPL-3.0'), 'strong-copyleft');
  assert.equal(classifyLicense('GPL-2.0+'), 'strong-copyleft');
  assert.equal(classifyLicense('AGPL-3.0'), 'strong-copyleft');
  assert.equal(classifyLicense('GPL-3.0 OR MIT'), 'permissive');
  assert.equal(classifyLicense('MIT AND GPL-3.0'), 'strong-copyleft');
  assert.equal(classifyLicense('SEE LICENSE IN LICENSE.txt'), 'unknown');
  assert.equal(classifyLicense(null), 'unknown');
});

test('ffmpeg configuration inspection flags GPL and nonfree builds', () => {
  const lgpl = 'configuration: --disable-gpl --enable-version3 --enable-videotoolbox';
  assert.equal(parseFfmpegConfiguration(`ffmpeg version 7.0\nbuilt with clang\n${lgpl}\n`), '--disable-gpl --enable-version3 --enable-videotoolbox');
  assert.deepEqual(inspectFfmpegConfiguration('--disable-gpl --enable-version3'), []);
  assert.deepEqual(inspectFfmpegConfiguration('--enable-gpl --enable-libx264').map((p) => p.code), ['FFMPEG_GPL']);
  assert.deepEqual(inspectFfmpegConfiguration('--enable-gpl --enable-nonfree').map((p) => p.code), ['FFMPEG_GPL', 'FFMPEG_NONFREE']);
  assert.deepEqual(inspectFfmpegConfiguration(null).map((p) => p.code), ['FFMPEG_CONFIG_UNREADABLE']);
  assert.equal(parseFfmpegConfiguration('no config here'), null);
});

test('collectNpmClosure walks dependencies transitively, skips dev and uninstalled packages', (t) => {
  const dir = tmp(t);
  write(path.join(dir, 'package.json'), { name: 'app', dependencies: { a: '1', missing: '1' }, devDependencies: { dev: '1' } });
  write(path.join(dir, 'node_modules/a/package.json'), { name: 'a', version: '1.0.0', license: 'MIT', dependencies: { b: '1' } });
  write(path.join(dir, 'node_modules/b/package.json'), { name: 'b', version: '2.0.0', licenses: [{ type: 'ISC' }] });
  write(path.join(dir, 'node_modules/dev/package.json'), { name: 'dev', version: '9.9.9', license: 'MIT' });
  const out = collectNpmClosure([dir]);
  assert.deepEqual(out.map((c) => `${c.name}@${c.version}:${c.licenseField}`), ['a@1.0.0:MIT', 'b@2.0.0:ISC']);
  assert.deepEqual(collectNpmClosure([dir], { includeDev: true }).map((c) => c.name), ['a', 'b', 'dev']);
});

function noticesFixture(t, { resources = {}, manifest = {}, files = {} } = {}) {
  const root = tmp(t);
  const resourcesDir = path.join(root, 'resources');
  for (const [rel, contents] of Object.entries(files)) write(path.join(resourcesDir, rel), contents);
  fs.mkdirSync(resourcesDir, { recursive: true });
  return { root, resourcesDir, manifest: { resources, ...manifest } };
}
const codes = (r) => r.problems.map((p) => `${p.code}:${p.id}`).sort();

test('every shipped resources/* directory must be declared', (t) => {
  const f = noticesFixture(t, { files: { 'ripgrep/rg': 'bin', 'ttyd/ttyd': 'bin' }, resources: { ripgrep: { name: 'ripgrep', license: 'MIT', sourceUrl: 'https://x/src.tgz' } } });
  const r = buildNotices({ ...f, npmComponents: [] });
  assert.deepEqual(codes(r), ['UNDECLARED_RESOURCE:ttyd']);
});

test('binary components need a license and a source URL; license can be read from files', (t) => {
  const f = noticesFixture(t, {
    files: { 'a/LICENSE': MIT, 'b/rg': 'bin' },
    resources: {
      a: { name: 'a', sourceUrl: 'https://x/a.tgz' },
      b: { name: 'b' },
    },
  });
  const r = buildNotices({ ...f, npmComponents: [] });
  const a = r.components.find((c) => c.name === 'a');
  assert.equal(a.license, 'MIT');
  assert.deepEqual(codes(r), ['MISSING_SOURCE_URL:b', 'UNKNOWN_LICENSE:b']);
});

test('strong copyleft is a problem unless waived with a reason', (t) => {
  const mk = (allow) => noticesFixture(t, {
    files: { 'gpl/LICENSE': GPL3 },
    resources: { gpl: { name: 'gpl', sourceUrl: 'https://x' } },
    manifest: { allow },
  });
  assert.deepEqual(codes(buildNotices({ ...mk([]), npmComponents: [] })), ['COPYLEFT:gpl']);
  assert.deepEqual(codes(buildNotices({ ...mk([{ id: 'gpl', reason: '' }]), npmComponents: [] })), ['COPYLEFT:gpl']);
  assert.deepEqual(codes(buildNotices({ ...mk([{ id: 'gpl', reason: '仅开发期工具，不随包分发' }]), npmComponents: [] })), []);
});

test('ffmpeg resource: GPL build is rejected, LGPL build passes, missing binary is reported', (t) => {
  const entry = { name: 'FFmpeg', version: '7.0', license: 'LGPL-2.1', sourceUrl: 'https://x/ffmpeg.tgz', check: 'ffmpeg' };
  const withBinary = (config) => {
    const f = noticesFixture(t, { files: { 'ffmpeg/darwin-arm64/ffmpeg': 'bin' }, resources: { ffmpeg: entry } });
    return buildNotices({ ...f, npmComponents: [], readFfmpegVersion: () => `ffmpeg version 7.0\nconfiguration: ${config}\n` });
  };
  assert.deepEqual(codes(withBinary('--disable-gpl --enable-version3')), []);
  assert.deepEqual(codes(withBinary('--enable-gpl --enable-libx264')), ['FFMPEG_GPL:ffmpeg']);

  const noBinary = noticesFixture(t, { files: { 'ffmpeg/README': 'x' }, resources: { ffmpeg: entry } });
  assert.deepEqual(codes(buildNotices({ ...noBinary, npmComponents: [] })), ['FFMPEG_BINARY_MISSING:ffmpeg']);
});

test('npm components: unknown license is reported; license text can substitute for a missing field', (t) => {
  const dir = tmp(t);
  write(path.join(dir, 'node_modules/p/package.json'), { name: 'p', version: '1.0.0' });
  write(path.join(dir, 'node_modules/p/LICENSE'), MIT);
  write(path.join(dir, 'node_modules/q/package.json'), { name: 'q', version: '1.0.0' });
  write(path.join(dir, 'package.json'), { name: 'app', dependencies: { p: '1', q: '1' } });
  const npmComponents = collectNpmClosure([dir]);
  const r = buildNotices({ root: dir, manifest: { resources: {} }, resourcesDir: null, npmComponents });
  assert.equal(r.components.find((c) => c.name === 'p').license, 'MIT');
  assert.deepEqual(codes(r), ['UNKNOWN_LICENSE:q@1.0.0']);
});

test('writeNotices publishes JSON plus copied license texts without leaking source paths', (t) => {
  const f = noticesFixture(t, {
    files: { 'a/LICENSE': MIT },
    resources: { a: { name: 'A', version: '1.2.3', sourceUrl: 'https://x/a.tgz', modified: false } },
  });
  const result = buildNotices({ ...f, npmComponents: [] });
  const out = path.join(f.root, 'out');
  const doc = writeNotices(result, out);
  assert.equal(doc.schema, 1);
  assert.equal(doc.components[0].licenseText, 'licenses/a.txt');
  assert.ok(fs.readFileSync(path.join(out, 'licenses/a.txt'), 'utf8').includes('Permission is hereby granted'));
  const json = fs.readFileSync(path.join(out, 'third-party-notices.json'), 'utf8');
  assert.ok(!json.includes(f.root), 'absolute build paths must not appear in the published file');
  assert.ok(!json.includes('licenseSourceFile'));
});


test('exact-version npm evidence requires a real recognizable license and does not waive unknown licenses', (t) => {
  const root = tmp(t), pkg = path.join(root, 'package'); fs.mkdirSync(pkg);
  const component = { id: '@owner/package@1.0.0', name: '@owner/package', version: '1.0.0', dir: pkg, licenseField: null, homepage: null };
  write(path.join(root, 'root-license.txt'), APACHE);
  const manifest = { npmEvidence: { [component.id]: { reason: 'Pinned monorepo license omitted from published package', licenseFile: 'root-license.txt', sourceUrl: 'https://example.test/source' } } };
  const result = buildNotices({ root, manifest, npmComponents: [component] });
  assert.deepEqual(result.problems, []); assert.equal(result.components[0].license, 'Apache-2.0');
  write(path.join(root, 'root-license.txt'), 'unknown');
  assert.equal(buildNotices({ root, manifest, npmComponents: [component] }).problems[0].code, 'UNKNOWN_LICENSE');
  write(path.join(root, 'root-license.txt'), APACHE);
  assert.equal(buildNotices({ root, manifest, npmComponents: [{ ...component, id: '@owner/package@2.0.0' }] }).problems[0].code, 'UNKNOWN_LICENSE');
});
