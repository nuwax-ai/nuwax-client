import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const policy = require(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/scripts/build/linux-package-policy.cjs'));

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-linux-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 按 GNU ar 布局写归档；deb 就是这种布局（macOS 自带的 ar 是 BSD 布局，不通用）。 */
function writeAr(file, members) {
  const parts = [Buffer.from('!<arch>\n', 'latin1')];
  for (const { name, data } of members) {
    const header = Buffer.alloc(60, 0x20);
    header.write(`${name}/`, 0, 16, 'latin1');
    header.write('0', 16, 12, 'latin1');
    header.write('0', 28, 12, 'latin1');
    header.write('0', 34, 12, 'latin1');
    header.write('100644', 40, 8, 'latin1');
    header.write(`${data.length}`, 48, 10, 'latin1');
    header.write('`\n', 58, 2, 'latin1');
    parts.push(header, data);
    if (data.length % 2) parts.push(Buffer.from('\n', 'latin1'));
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

/**
 * 构造一个 deb：数据归档里放普通文件；带硬链接时再放一条指向同一 inode 的路径。
 * tar 遇到同一 inode 的第二个路径会写成类型 'h' 的条目，安装时需要重建链接。
 * 控制归档默认声明 package.json 里配置的全部依赖，传入 depends 可以改写。
 */
function buildDeb(t, { withHardLink, depends = policy.configuredDebDepends(), controlCompression = 'none' } = {}) {
  const dir = temporary(t);
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(path.join(tree, 'opt/Nuwax/resources'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'opt/Nuwax/resources/icon.png'), 'icon-bytes');
  if (withHardLink) {
    fs.linkSync(path.join(tree, 'opt/Nuwax/resources/icon.png'), path.join(tree, 'opt/Nuwax/resources/icon-copy.png'));
  }
  const member = path.join(dir, 'data.tar');
  const tar = spawnSync('tar', ['-cf', member, '-C', tree, 'opt'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);

  // fpm 写出的控制归档成员名是 ./control；这里按同样的布局打包，必要时加 gzip。
  const controlDir = path.join(dir, 'control');
  fs.mkdirSync(controlDir);
  const control = [
    'Package: nuwax',
    'Version: 3.3.0',
    'Architecture: arm64',
    'Maintainer: Nuwax Team <dev@example.invalid>',
    ...(depends?.length ? [`Depends: ${depends.join(', ')}`] : []),
    'Description: test package',
    ' second line of the description',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(controlDir, 'control'), control);
  const controlName = `control.tar${controlCompression === 'gzip' ? '.gz' : ''}`;
  const controlMember = path.join(dir, controlName);
  const controlTar = spawnSync('tar', [`-c${controlCompression === 'gzip' ? 'z' : ''}f`, controlMember, '-C', controlDir, './control'], { encoding: 'utf8' });
  assert.equal(controlTar.status, 0, controlTar.stderr);

  const deb = path.join(dir, 'package.deb');
  writeAr(deb, [
    { name: controlName, data: fs.readFileSync(controlMember) },
    { name: 'data.tar', data: fs.readFileSync(member) },
  ]);
  return { deb, dir, member };
}

test('Linux packaging disables builder hard links so packages install across filesystems', () => {
  const linux = policy.applyHardLinkPolicy({ PATH: '/bin' }, 'linux');
  assert.equal(linux.USE_HARD_LINKS, 'false');
  assert.equal(linux.PATH, '/bin');
  for (const platform of ['darwin', 'win32']) {
    const unchanged = { PATH: '/bin' };
    assert.equal(policy.applyHardLinkPolicy(unchanged, platform), unchanged);
    assert.equal(policy.applyHardLinkPolicy(unchanged, platform).USE_HARD_LINKS, undefined);
  }
});

test('a deb without hard links passes the package link check', (t) => {
  const { deb, dir } = buildDeb(t, { withHardLink: false });
  assert.equal(policy.verifyLinuxPackageLinks(dir).checked, 1);
  assert.deepEqual(policy.inspectDebHardLinks(deb).hardLinks, []);
});

test('a deb with a hard link is rejected with the offending path', (t) => {
  const { deb, dir } = buildDeb(t, { withHardLink: true });
  const inspected = policy.inspectDebHardLinks(deb);
  assert.equal(inspected.hardLinks.length, 1);
  assert.match(inspected.hardLinks[0].entry, /icon-copy\.png$/);
  assert.match(inspected.hardLinks[0].target, /icon\.png$/);
  assert.throws(() => policy.verifyLinuxPackageLinks(dir), /硬链接|hard link/i);
});

test('the ar reader accepts the GNU layout that deb packages use', (t) => {
  const { deb } = buildDeb(t, { withHardLink: false });
  const members = policy.readArMembers(deb);
  assert.deepEqual(members.map((member) => member.name), ['control.tar', 'data.tar']);
  assert.ok(members.every((member) => member.size > 0));
});

test('the configured deb dependencies keep every electron-builder default and add zenity', () => {
  // electron-builder 25 drops its own defaults as soon as deb.depends is set, so the nine
  // defaults below have to stay in package.json next to zenity. The list was read from the
  // fpm command line and from the control files of packages built with electron-builder
  // 25.1.8 / app-builder-bin 5.0.0-alpha.10; re-read it when either is upgraded.
  assert.deepEqual(policy.configuredDebDepends(), [
    'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0',
    'zenity',
  ]);
});

test('a deb that declares every configured dependency passes the dependency check', (t) => {
  const { dir } = buildDeb(t, { withHardLink: false });
  assert.deepEqual(policy.verifyLinuxPackageDependencies(dir), { checked: 1, dependencies: policy.configuredDebDepends() });
});

test('a deb that lacks a dependency is rejected with the missing package', (t) => {
  const { dir } = buildDeb(t, { withHardLink: false, depends: policy.configuredDebDepends().filter((name) => name !== 'zenity') });
  assert.throws(() => policy.verifyLinuxPackageDependencies(dir), /zenity/);
  const bare = buildDeb(t, { withHardLink: false, depends: [] }).dir;
  assert.throws(() => policy.verifyLinuxPackageDependencies(bare), /libgtk-3-0/);
});

test('the control file is read through compressed archives and version constraints are ignored', (t) => {
  const { deb, dir } = buildDeb(t, {
    withHardLink: false,
    controlCompression: 'gzip',
    depends: ['libgtk-3-0 (>= 3.22)', 'dbus | dbus-x11', 'zenity (>= 3.0)'],
  });
  assert.equal(policy.readDebControl(deb).Package, 'nuwax');
  assert.equal(policy.readDebControl(deb).Depends, 'libgtk-3-0 (>= 3.22), dbus | dbus-x11, zenity (>= 3.0)');
  assert.equal(policy.readDebControl(deb).Description, 'test package second line of the description');
  assert.deepEqual(policy.dependencyNames(policy.readDebControl(deb).Depends), ['libgtk-3-0', 'dbus', 'zenity']);
  // 版本约束不影响判断；多选一的依赖按第一个名字识别（dbus | dbus-x11 → dbus）。
  const expectedFile = path.join(path.dirname(deb), 'expected.json');
  fs.writeFileSync(expectedFile, JSON.stringify({ build: { deb: { depends: ['libgtk-3-0', 'zenity', 'dbus'] } } }));
  assert.equal(policy.verifyLinuxPackageDependencies(dir, expectedFile).checked, 1);
  fs.writeFileSync(expectedFile, JSON.stringify({ build: { deb: { depends: ['libnss3'] } } }));
  assert.throws(() => policy.verifyLinuxPackageDependencies(dir, expectedFile), /libnss3/);
});

test('glibc versions compare as two integers, not as decimals', () => {
  // 2.9 and 2.10 are 2.9 > 2.1 as decimals, but 2.9 < 2.10 as glibc versions.
  // Getting this wrong makes the gate reject artifacts that only need GLIBC_2.9.
  const v = (text) => policy.parseGlibcVersion(text);
  assert.ok(policy.compareGlibcVersions(v('2.9'), v('2.10')) < 0);
  assert.ok(policy.compareGlibcVersions(v('2.10'), v('2.28')) < 0);
  assert.equal(policy.compareGlibcVersions(v('2.28'), v('2.28')), 0);
  assert.ok(policy.compareGlibcVersions(v('2.29'), v('2.28')) > 0);
  assert.ok(policy.compareGlibcVersions(v('3.0'), v('2.99')) > 0);
  for (const invalid of ['', '2', '2.28.1', 'x.y', null, undefined]) assert.equal(policy.parseGlibcVersion(invalid), null);
});

test('the glibc floor check accepts anything up to the limit and rejects anything above it', () => {
  const binary = path.join(os.tmpdir(), `nuwax-glibc-floor-${process.pid}.so`);
  try {
    const candidates = ['/usr/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib/aarch64-linux-gnu/libc.so.6', '/lib/aarch64-linux-gnu/libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib/libc.so.6'];
    const system = candidates.find((file) => fs.existsSync(file));
    if (!system) return;
    fs.copyFileSync(system, binary);
    const highest = policy.highestGlibcVersion(binary);
    if (!highest) return;
    const at = policy.checkGlibcFloor(binary, `${highest.major}.${highest.minor}`);
    assert.equal(at.ok, true);
    assert.equal(at.required, `${highest.major}.${highest.minor}`);
    const oneBelow = highest.minor === 0 ? { major: highest.major - 1, minor: 99 } : { major: highest.major, minor: highest.minor - 1 };
    const below = policy.checkGlibcFloor(binary, `${oneBelow.major}.${oneBelow.minor}`);
    assert.equal(below.ok, false);
    assert.match(below.reason, /需要 GLIBC_/);
  } finally {
    fs.rmSync(binary, { force: true });
  }
  assert.match(policy.checkGlibcFloor('/nonexistent/file.so', '2.28').reason, /不存在/);
  assert.match(policy.checkGlibcFloor('/nonexistent/file.so', 'garbage').reason, /格式无效/);
});
