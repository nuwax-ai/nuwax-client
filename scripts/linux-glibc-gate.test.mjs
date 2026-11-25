import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALLOWLIST,
  GLIBC_FLOOR,
  isElfFile,
  listFiles,
  patternToRegExp,
  readHighestGlibc,
  scanGlibc,
  unpackedAppDir,
  verifyLinuxGlibc,
} from './client/linux-glibc-gate.mjs';
import { packagedResources } from './prepare-release-updater.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts/client/linux-glibc-gate.mjs');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-glibc-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build a minimal ELF64 shared object whose .gnu.version_r requires the given
 * glibc versions. It carries only what the gate reads — the ELF header, a
 * string table, and the verneed chain — which is also the only thing the
 * dynamic loader consults when it reports "version `GLIBC_x.y' not found".
 *
 * The shape copies a real binary: one Verneed per version, each with a single
 * Vernaux, so `readelf -V` can be used as an independent referee.
 *
 * Layout: [elf header][verneed × n][dynstr][section headers]
 */
function buildElf({ versions, library = 'libc.so.6', machine = 0xb7 } = {}) {
  const SHT_STRTAB = 3;
  const SHT_GNU_verneed = 0x6ffffffe;
  const SHT_NULL = 0;
  const SHF_ALLOC = 0x2;

  // Strings: the library name first, then one entry per version.
  const strings = [library, ...versions];
  const dynstr = Buffer.alloc(strings.reduce((sum, text) => sum + text.length + 1, 0));
  const offsets = [];
  let cursor = 0;
  for (const text of strings) {
    offsets.push(cursor);
    dynstr.write(text, cursor);
    cursor += text.length + 1;
  }
  const [libraryOffset, ...versionOffsets] = offsets;

  const verneedOffset = 64;
  const verneedSize = versions.length * 32; // each Verneed is 16 bytes + its 16-byte Vernaux
  const dynstrOffset = verneedOffset + verneedSize;
  const shoff = dynstrOffset + dynstr.length;
  const buffer = Buffer.alloc(shoff + 3 * 64);

  buffer.write('\x7fELF', 0, 'latin1');
  buffer[4] = 2;                 // ELFCLASS64
  buffer[5] = 1;                 // little endian
  buffer.writeUInt16LE(1, 16);   // e_type
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);   // e_version
  buffer.writeBigUInt64LE(BigInt(shoff), 0x28); // e_shoff
  buffer.writeUInt16LE(64, 0x3a);               // e_shentsize
  buffer.writeUInt16LE(3, 0x3c);                // e_shnum
  buffer.writeUInt16LE(0, 0x3e);                // e_shstrndx (the gate does not use it)

  // The string table must actually be placed in the image; the section header
  // only points at it.
  dynstr.copy(buffer, dynstrOffset);

  versions.forEach((_, index) => {
    const entry = verneedOffset + index * 32;
    // Elf64_Verneed: vn_version(2) vn_cnt(2) vn_file(4) vn_aux(4) vn_next(4)
    buffer.writeUInt16LE(1, entry);
    buffer.writeUInt16LE(1, entry + 2);
    buffer.writeUInt32LE(libraryOffset, entry + 4);
    buffer.writeUInt32LE(16, entry + 8);                              // the Vernaux, relative to this Verneed
    buffer.writeUInt32LE(index + 1 < versions.length ? 32 : 0, entry + 12);
    // Elf64_Vernaux: vna_hash(4) vna_flags(2) vna_other(2) vna_name(4) vna_next(4)
    const aux = entry + 16;
    buffer.writeUInt32LE(0, aux);
    buffer.writeUInt16LE(0, aux + 4);
    buffer.writeUInt16LE(index + 2, aux + 6);
    buffer.writeUInt32LE(versionOffsets[index], aux + 8);
    buffer.writeUInt32LE(0, aux + 12);                                // single Vernaux
  });

  // Elf64_Shdr: name(4) type(4) flags(8) addr(8) offset(8) size(8) link(4) info(4) addralign(8) entsize(8)
  const writeSection = (index, { type, flags, offset, size, link, info, addralign }) => {
    const at = shoff + index * 64;
    buffer.writeUInt32LE(0, at);
    buffer.writeUInt32LE(type, at + 4);
    buffer.writeBigUInt64LE(BigInt(flags), at + 8);
    buffer.writeBigUInt64LE(0n, at + 16);
    buffer.writeBigUInt64LE(BigInt(offset), at + 24);
    buffer.writeBigUInt64LE(BigInt(size), at + 32);
    buffer.writeUInt32LE(link, at + 40);
    buffer.writeUInt32LE(info, at + 44);
    buffer.writeBigUInt64LE(BigInt(addralign), at + 48);
  };
  writeSection(0, { type: SHT_NULL, flags: 0, offset: 0, size: 0, link: 0, info: 0, addralign: 0 });
  writeSection(1, { type: SHT_STRTAB, flags: SHF_ALLOC, offset: dynstrOffset, size: dynstr.length, link: 0, info: 0, addralign: 1 });
  // sh_link is the string table, sh_info the number of Verneed entries.
  writeSection(2, { type: SHT_GNU_verneed, flags: SHF_ALLOC, offset: verneedOffset, size: verneedSize, link: 1, info: versions.length, addralign: 1 });

  return buffer;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** An unpacked app directory shape that the gate expects for Linux arm64. */
function appRoot(dir) {
  const root = path.join(dir, 'linux-arm64-unpacked');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test('the gate reads the highest GLIBC version requirement out of a real verneed chain', (t) => {
  // The parser takes a path, so each fixture is written to disk first.
  const dir = temporary(t);
  const highest = (versions) => {
    const file = path.join(dir, `fixture-${versions.join('_')}.so`);
    write(file, buildElf({ versions }));
    return readHighestGlibc(file);
  };
  assert.deepEqual(highest(['GLIBC_2.17', 'GLIBC_2.4', 'GLIBC_2.28']), { major: 2, minor: 28 });
  assert.deepEqual(highest(['GLIBC_2.34']), { major: 2, minor: 34 });
  // 2.9 and 2.10 are ordered as two integers, not as decimals.
  assert.deepEqual(highest(['GLIBC_2.9', 'GLIBC_2.10']), { major: 2, minor: 10 });
  // No glibc version at all (static, or only other libraries' versions).
  assert.equal(highest(['OPENSSL_3.0.0', 'VX_1.2']), null);
});

test('the parser agrees with readelf on real binaries when binutils is available', (t) => {
  if (spawnSync('readelf', ['--version']).error) return;
  const dir = temporary(t);
  const lib = ['/lib/aarch64-linux-gnu/libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib/aarch64-linux-gnu/libc.so.6', '/usr/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib/libc.so.6']
    .find((file) => fs.existsSync(file));
  if (!lib) return;
  const copy = path.join(dir, 'libc.so.6');
  fs.copyFileSync(lib, copy);
  // `readelf -V` prints three sections, in whatever order they sit in the file
  // (for libc.so.6: symbols, definitions, needs). Only "Version needs" lists
  // what the file requires — the thing the dynamic loader checks and the only
  // thing the gate reads. "Version definition" lists what the file itself
  // *exports* (libc.so.6 defines every GLIBC_ version up to its own), and the
  // symbol table repeats both. Taking the maximum over the whole listing would
  // compare the gate against versions the file does not need at all.
  const listing = spawnSync('readelf', ['-V', copy], { encoding: 'utf8' }).stdout;
  // Split on every section heading, then keep the block that starts with "needs".
  const blocks = listing.split(/^(?=Version (?:needs|definition|symbols) section)/m);
  const needs = blocks.find((block) => /^Version needs section/m.test(block));
  assert.ok(needs, `readelf -V output has no needs section:\n${listing.slice(0, 400)}`);
  const required = [...needs.matchAll(/Name: GLIBC_(\d+)\.(\d+)/g)]
    .map((match) => ({ major: Number(match[1]), minor: Number(match[2]) }));
  assert.ok(required.length > 0, 'no GLIBC requirement found in the needs section');
  const highest = required.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  assert.deepEqual(readHighestGlibc(copy), highest);
});

/** glibc versions order as two integers: 2.9 < 2.10 < 2.28 < 3.0. */
function compare(a, b) {
  return (a.major - b.major) || (a.minor - b.minor);
}

test('the unpacked app directory follows the one rule the repo already has', () => {
  // x64 has no arch suffix, arm64 does. The gate takes this from packagedResources
  // so there is a single source; the image workflow asks the gate instead of
  // composing the name itself (it composed `linux-x64-unpacked` once and the gate
  // could not find the directory).
  assert.equal(unpackedAppDir('/out', 'x64'), path.join('/out', 'linux-unpacked'));
  assert.equal(unpackedAppDir('/out', 'arm64'), path.join('/out', 'linux-arm64-unpacked'));
  // and it agrees with the helper the release workflows use to locate resources
  assert.equal(unpackedAppDir('/out', 'arm64'), path.dirname(packagedResources('/out', 'linux', 'arm64')));
  assert.equal(unpackedAppDir('/out', 'x64'), path.dirname(packagedResources('/out', 'linux', 'x64')));
  // the gate no longer carries its own copy of the rule: it derives the
  // directory from packagedResources instead of naming it itself
  const source = fs.readFileSync(cli, 'utf8');
  assert.ok(source.includes('path.dirname(packagedResources('), 'gate must take the directory from packagedResources');
  assert.ok(!source.includes("'linux-arm64-unpacked' ? "), 'gate names the directory itself');
  // the image workflow does not compose the directory name either
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/linux-native-image.yml'), 'utf8');
  assert.ok(workflow.includes('unpackedAppDir('), 'image workflow must ask the gate for the app directory');
  assert.ok(!workflow.includes('linux-$TARGET_ARCH-unpacked'), 'image workflow composes the app directory name itself');
});

test('non-ELF files, symlinks and missing files are not treated as ELF', (t) => {
  const dir = temporary(t);
  const text = path.join(dir, 'notes.txt');
  write(text, 'not a binary');
  assert.equal(isElfFile(text), false);
  assert.equal(isElfFile(path.join(dir, 'absent')), false);
  const elf = path.join(dir, 'fixture.so');
  write(elf, buildElf({ versions: ['GLIBC_2.17'] }));
  assert.equal(isElfFile(elf), true);
  // A truncated header is not an ELF.
  const truncated = path.join(dir, 'truncated');
  write(truncated, Buffer.from([0x7f, 0x45]));
  assert.equal(isElfFile(truncated), false);
});

test('a directory of ELFs is scanned and only the ones above the floor are reported', (t) => {
  const root = appRoot(temporary(t));
  write(path.join(root, 'resources/node/addon.node'), buildElf({ versions: ['GLIBC_2.28'] }));
  write(path.join(root, 'resources/legacy/old.so'), buildElf({ versions: ['GLIBC_2.9'] }));
  write(path.join(root, 'resources/static/tool'), buildElf({ versions: [] }));
  write(path.join(root, 'resources/README.md'), 'text');
  const result = scanGlibc(root);
  assert.equal(result.elves, 3);
  assert.deepEqual(result.violations, []);
  write(path.join(root, 'resources/fresh/libnew.so'), buildElf({ versions: ['GLIBC_2.17', 'GLIBC_2.39'] }));
  const after = scanGlibc(root);
  assert.deepEqual(after.violations, [{ file: 'resources/fresh/libnew.so', required: '2.39' }]);
});

test('the floor is inclusive and exactly at the limit passes', (t) => {
  const root = appRoot(temporary(t));
  write(path.join(root, 'a.so'), buildElf({ versions: ['GLIBC_2.28'] }));
  write(path.join(root, 'b.so'), buildElf({ versions: ['GLIBC_2.29'] }));
  const result = scanGlibc(root);
  assert.deepEqual(result.violations.map((item) => item.file), ['b.so']);
});

test('allowlisted paths are reported as exemptions, never as violations', (t) => {
  const root = appRoot(temporary(t));
  write(path.join(root, 'resources/agent-desktop/linux-arm64/agent-desktop-linux-arm64'), buildElf({ versions: ['GLIBC_2.35'] }));
  write(path.join(root, 'resources/agent-desktop/linux-arm64/agent-desktop-linux-clipboard-owner-linux-arm64'), buildElf({ versions: ['GLIBC_2.34'] }));
  const result = scanGlibc(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.allowed.length, 2);
  assert.ok(result.allowed.every((item) => item.reason));
  // The exemption does not leak onto files outside the allowlisted shape.
  write(path.join(root, 'resources/agent-desktop/linux-arm64/agent-desktop-helper'), buildElf({ versions: ['GLIBC_2.35'] }));
  assert.deepEqual(scanGlibc(root).violations.map((item) => item.file), ['resources/agent-desktop/linux-arm64/agent-desktop-helper']);
});

test('every allowlist entry must state a reason and a resolution', () => {
  for (const entry of ALLOWLIST) {
    assert.match(entry.reason, /\S/);
    assert.match(entry.resolution, /\S/);
  }
  assert.throws(() => scanGlibc(os.tmpdir(), { allowlist: [{ pattern: 'x' }] }), /必须写明 reason 和 resolution/);
  assert.throws(() => scanGlibc(os.tmpdir(), { floor: 'garbage' }), /格式无效/);
});

test('patterns match a path relative to the install root and a star does not cross a slash', () => {
  // Paths are relative to linux-<arch>-unpacked/, so the real resources/ prefix is part of the match.
  const re = patternToRegExp('resources/agent-desktop/*/agent-desktop-linux-*');
  assert.ok(re.test('resources/agent-desktop/linux-arm64/agent-desktop-linux-arm64'));
  assert.ok(re.test('resources/agent-desktop/linux-x64/agent-desktop-linux-x64'));
  assert.ok(re.test('resources/agent-desktop/linux-arm64/agent-desktop-linux-clipboard-owner-linux-arm64'));
  assert.ok(!re.test('resources/agent-desktop/linux-arm64/nested/agent-desktop-linux-arm64'));
  assert.ok(!re.test('resources/computer-use/agent-desktop-linux-arm64'));
  assert.ok(patternToRegExp('a.b').test('a.b') && !patternToRegExp('a.b').test('axb'));
});

test('the gate walks nested directories and ignores symlinks', (t) => {
  const root = temporary(t);
  write(path.join(root, 'a/b/c.so'), 'x');
  write(path.join(root, 'top'), 'y');
  fs.symlinkSync(path.join(root, 'top'), path.join(root, 'link'));
  assert.deepEqual(listFiles(root).map((file) => path.relative(root, file)).sort(), [path.join('a', 'b', 'c.so'), 'top']);
});

test('verification targets the unpacked app directory for the architecture and fails above the floor', (t) => {
  const output = temporary(t);
  const root = appRoot(output);
  write(path.join(root, 'resources/ok.node'), buildElf({ versions: ['GLIBC_2.28'] }));
  assert.equal(verifyLinuxGlibc(output, { platform: 'linux', arch: 'arm64' }).violations.length, 0);
  write(path.join(root, 'resources/bad.node'), buildElf({ versions: ['GLIBC_2.34'] }));
  assert.throws(() => verifyLinuxGlibc(output, { platform: 'linux', arch: 'arm64' }), /resources\/bad\.node\s+需要 GLIBC_2\.34/);
  const reported = verifyLinuxGlibc(output, { platform: 'linux', arch: 'arm64', reportOnly: true });
  assert.equal(reported.violations.length, 1);
  // Non-Linux platforms are out of scope, and a missing output directory is an error.
  assert.equal(verifyLinuxGlibc(output, { platform: 'darwin', arch: 'arm64' }), null);
  assert.throws(() => verifyLinuxGlibc(path.join(output, 'absent'), { platform: 'linux', arch: 'arm64' }), /找不到打包目录/);
});

test('the CLI validates its arguments and refuses to pretend it runs on another platform', (t) => {
  const output = temporary(t);
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  // Argument parsing is platform independent.
  assert.equal(run([]).status, 1);
  assert.equal(run(['--verify-output', output, '--bogus']).status, 1);
  assert.equal(run(['--verify-output', output, '--verify-output', output]).status, 1);
  // --platform names the layout to expect; it cannot turn a non-Linux host into one.
  // A mismatch means the wrong runner was asked to run this (v3.3.0-beta.3's Windows
  // build passed --platform linux and died looking for a linux-unpacked directory).
  const other = process.platform === 'linux' ? 'darwin' : 'linux';
  const wrong = run(['--verify-output', output, '--platform', other, '--arch', 'arm64']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, new RegExp(`--platform ${other} 与当前系统 ${process.platform} 不一致.*只应在 Linux runner 上执行`));
  if (process.platform !== 'linux') {
    // Without --platform a non-Linux host reports that the gate does not apply.
    const skip = run(['--verify-output', output]);
    assert.equal(skip.status, 0);
    assert.match(skip.stdout, /非 Linux 平台，本门禁不适用/);
    return;
  }
  // On Linux the CLI runs for real: it scans, reports exemptions and fails on violations.
  const root = appRoot(output);
  write(path.join(root, 'resources/agent-desktop/linux-arm64/agent-desktop-linux-arm64'), buildElf({ versions: ['GLIBC_2.35'] }));
  const ok = run(['--verify-output', output, '--arch', 'arm64']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /豁免：resources\/agent-desktop\/linux-arm64\/agent-desktop-linux-arm64 需要 GLIBC_2\.35/);
  write(path.join(root, 'resources/bad.node'), buildElf({ versions: ['GLIBC_2.39'] }));
  const bad = run(['--verify-output', output, '--arch', 'arm64']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /resources\/bad\.node\s+需要 GLIBC_2\.39/);
  const report = run(['--verify-output', output, '--arch', 'arm64', '--report-only']);
  assert.equal(report.status, 0);
  assert.match(report.stderr, /只报告，不失败/);
});

test('the floor matches the UOS 1050 target the image exists for', () => {
  assert.equal(GLIBC_FLOOR, '2.28');
});
