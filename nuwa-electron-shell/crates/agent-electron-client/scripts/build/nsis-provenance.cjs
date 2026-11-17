'use strict';

// NSIS 3.0.4.1 x86 Unicode, non-solid Deflate (electron-builder 25.1.8).
// Format: https://github.com/kichik/nsis/blob/v304/Source/exehead/fileform.h
// Compare the actual VM program and native stub, not just extracted files.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const HEADER_SIZE = 300, SECTION_SIZE = 16408, ENTRY_SIZE = 28, EW_EXTRACTFILE = 20;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function payloadIdentity(record) {
  return record.pe ? `pe:${record.pe.normalizedSha256}` : record.script ? `script:${record.script.sha256}` : `bytes:${record.sha256}`;
}
function nsisIdentity(file, { payloads, special = [], applicationSize }) {
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
  const read = (offset, length) => {
    assert(Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= size, 'Truncated NSIS data');
    const bytes = Buffer.alloc(length); assert.equal(fs.readSync(fd, bytes, 0, length, offset), length); return bytes;
  };
  try {
    const dos = read(0, 64); assert.equal(dos.toString('ascii', 0, 2), 'MZ');
    const pe = dos.readUInt32LE(60), coff = read(pe, 24);
    assert.equal(coff.toString('binary', 0, 4), 'PE\0\0'); assert.equal(coff.readUInt16LE(4), 0x14c, 'Expected x86 NSIS');
    const opt = pe + 24, optionalSize = coff.readUInt16LE(20), optional = read(opt, optionalSize);
    assert.equal(optional.readUInt16LE(0), 0x10b, 'Expected PE32 NSIS');
    let overlay = 0;
    const sections = read(opt + optionalSize, coff.readUInt16LE(6) * 40);
    for (let at = 0; at < sections.length; at += 40) overlay = Math.max(overlay, sections.readUInt32LE(at + 20) + sections.readUInt32LE(at + 16));
    assert(overlay >= opt + optionalSize && overlay < 4 * 1024 * 1024, 'Unexpected NSIS stub size');
    const stub = read(0, overlay), first = read(overlay, 32);
    assert.equal(first.subarray(4, 20).toString('hex'), 'efbeadde4e756c6c736f6674496e7374', 'Missing NSIS first header');
    const flags = first.readUInt32LE(0), headerSize = first.readUInt32LE(20), compressed = first.readUInt32LE(28);
    assert((flags & ~15) === 0 && headerSize >= HEADER_SIZE && headerSize <= 16 * 1024 * 1024, 'Unsupported NSIS header');
    const packedSize = compressed & 0x7fffffff;
    assert(packedSize <= 16 * 1024 * 1024, 'Unsupported solid NSIS stream');
    const packed = read(overlay + 32, packedSize);
    const header = compressed & 0x80000000 ? inflateRawSync(packed, { maxOutputLength: headerSize }) : packed;
    assert.equal(header.length, headerSize, 'Unsupported NSIS compression');
    const block = index => [header.readUInt32LE(4 + index * 8), header.readUInt32LE(8 + index * 8)];
    const [sectionOffset, sectionCount] = block(1), [entries, count] = block(2), [strings] = block(3), [languages] = block(4);
    assert.equal(block(0)[0], HEADER_SIZE, 'Unsupported NSIS header layout');
    assert.equal(sectionOffset + sectionCount * SECTION_SIZE, entries, 'Unsupported Unicode NSIS sections');
    assert.equal(entries + count * ENTRY_SIZE, strings, 'Unsupported NSIS instruction layout');
    assert(strings <= languages && languages <= header.length && strings % 2 === 0, 'Invalid NSIS strings');
    // Display-only section sizes change when signatures enlarge embedded files.
    for (let i = 0; i < sectionCount; i++) header.fill(0, sectionOffset + i * SECTION_SIZE + 20, sectionOffset + i * SECTION_SIZE + 24);
    // Builder 25 uses ceil(bytes/1024) for UNPACKED_SIZE and round(bytes/1024)
    // for ESTIMATED_SIZE. Both are bound to the verified application byte count;
    // no other numeric/string changes are allowed in the program.
    if (applicationSize !== undefined) {
      assert(Number.isSafeInteger(applicationSize) && applicationSize > 0, 'Invalid verified application byte count');
      for (const estimate of new Set([Math.ceil(applicationSize / 1024), Math.round(applicationSize / 1024)])) {
        const value = Buffer.from(String(estimate) + '\0', 'utf16le');
        const positions = [];
        for (let at = strings; at + value.length <= languages; at += 2) {
          if ((at === strings || header.readUInt16LE(at - 2) === 0) && header.subarray(at, at + value.length).equals(value)) positions.push(at);
        }
        assert.equal(positions.length, 1, 'Missing or ambiguous NSIS application size constant');
        header.fill(0x30, positions[0], positions[0] + value.length - 2);
      }
    }
    const allowed = new Map(Object.values(payloads).map(record => [record.sha256, payloadIdentity(record)]));
    for (const [sha256, identity] of special) allowed.set(sha256, identity);
    const dataStart = overlay + 32 + packedSize, references = [], chunks = new Map();
    for (let i = 0; i < count; i++) {
      const at = entries + i * ENTRY_SIZE, opcode = header.readUInt32LE(at);
      if (opcode !== EW_EXTRACTFILE) continue; // preserve every other operand
      const offset = header.readUInt32LE(at + 12);
      if (!chunks.has(offset)) {
        const length = read(dataStart + offset, 4).readUInt32LE(0), compressedFile = Boolean(length & 0x80000000), bytes = length & 0x7fffffff;
        let sha256;
        if (compressedFile) {
          assert(bytes <= 64 * 1024 * 1024, 'Unexpected compressed NSIS payload');
          sha256 = digest(inflateRawSync(read(dataStart + offset + 4, bytes), { maxOutputLength: 64 * 1024 * 1024 }));
        } else {
          const h = createHash('sha256');
          for (let pos = 0; pos < bytes; pos += 1024 * 1024) h.update(read(dataStart + offset + 4 + pos, Math.min(1024 * 1024, bytes - pos)));
          sha256 = h.digest('hex');
        }
        assert(allowed.has(sha256), 'NSIS instruction references unverified payload bytes');
        chunks.set(offset, allowed.get(sha256));
      }
      references.push([i, chunks.get(offset)]);
      header.fill(0, at + 12, at + 16); // bind relocated data to its verified body above
      if ((header.readUInt32LE(at + 4) & 7) < 3) header.fill(0, at + 16, at + 24);
    }
    // Authenticode changes only these native header fields. All native code,
    // resources, VM opcodes, branches, strings and extraction destinations stay.
    stub.fill(0, opt + 64, opt + 68); stub.fill(0, opt + 128, opt + 136);
    return { flags, stubSha256: digest(stub), programSha256: digest(header), references };
  } finally { fs.closeSync(fd); }
}
module.exports = { nsisIdentity };
