import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import nsis from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/nsis-provenance.cjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsis-proof-'));
  try { run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function installer({ payload = Buffer.from('original'), relocated = false, modifiedOpcode = false, destination = 'safe', stubChange = false, size = 1024, conditionalOverwrite = false } = {}) {
  const stub = Buffer.alloc(512); stub.write('MZ'); stub.writeUInt32LE(64, 60); stub.write('PE\0\0', 64);
  stub.writeUInt16LE(0x14c, 68); stub.writeUInt16LE(1, 70); stub.writeUInt16LE(224, 84); stub.writeUInt16LE(0x10b, 88);
  stub.writeUInt32LE(512, 312 + 16); stub.writeUInt32LE(0, 312 + 20); if (stubChange) stub[450] = 42;
  const entries = 300 + 16408, strings = entries + 56, text = Buffer.from(`${destination}\0${Math.ceil(size / 1024)}\0`, 'utf16le');
  const header = Buffer.alloc(strings + text.length);
  for (const [index, offset, count] of [[0,300,0],[1,300,1],[2,entries,2],[3,strings,0],[4,header.length,0]]) {
    header.writeUInt32LE(offset, 4 + index * 8); header.writeUInt32LE(count, 8 + index * 8);
  }
  header.writeUInt32LE(relocated ? 8 : 4, 320); // section display size
  header.writeUInt32LE(20, entries); header.writeUInt32LE(relocated ? 8 : 0, entries + 12);
  if (conditionalOverwrite) header.writeUInt32LE(3, entries + 4);
  header.writeUInt32LE(relocated ? 100 : 1, entries + 16); header.writeUInt32LE(relocated ? 200 : 2, entries + 20);
  header.writeUInt32LE(modifiedOpcode ? 23 : 1, entries + 28); text.copy(header, strings);
  const packed = deflateRawSync(header), first = Buffer.alloc(32);
  Buffer.from('efbeadde4e756c6c736f6674496e7374','hex').copy(first,4); first.writeUInt32LE(header.length,20); first.writeUInt32LE(packed.length + 0x80000000,28);
  const bytes = deflateRawSync(payload), chunk = Buffer.alloc(4); chunk.writeUInt32LE(bytes.length + 0x80000000);
  return Buffer.concat([stub,first,packed,Buffer.alloc(relocated ? 8 : 0),chunk,bytes]);
}
test('compiled NSIS proof accepts relocated, re-signed payload with refreshed size and time metadata', () => fixture(dir => {
  const before = Buffer.from('original'), after = Buffer.from('signed-original');
  const compare = (name, options, bytes) => {
    const file = path.join(dir,name); fs.writeFileSync(file,installer(options));
    return nsis.nsisIdentity(file,{payloads:{file:{sha256:hash(bytes),pe:{normalizedSha256:'same-code'}}},applicationSize:options.size});
  };
  assert.deepEqual(compare('before.exe',{payload:before,size:1024},before), compare('after.exe',{payload:after,relocated:true,size:2048},after));
}));
test('same extracted file set cannot hide modified delete instructions, destinations or native stub', () => fixture(dir => {
  const options={payloads:{file:{sha256:hash(Buffer.from('original'))}},applicationSize:1024};
  const compare = changes => {const file=path.join(dir,'setup.exe');fs.writeFileSync(file,installer(changes));return nsis.nsisIdentity(file,options);};
  const baseline=compare({});
  for(const changes of [{modifiedOpcode:true},{destination:'evil'},{stubChange:true}]) assert.notDeepEqual(compare(changes),baseline);
}));
test('every File instruction binds to verified payload bytes and preserves conditional overwrite times', () => fixture(dir => {
  const file=path.join(dir,'setup.exe');fs.writeFileSync(file,installer({payload:Buffer.from('unverified')}));
  assert.throws(()=>nsis.nsisIdentity(file,{payloads:{file:{sha256:hash(Buffer.from('original'))}},applicationSize:1024}),/unverified payload/);
  const options={payloads:{file:{sha256:hash(Buffer.from('original'))}},applicationSize:1024};
  fs.writeFileSync(file,installer({conditionalOverwrite:true}));const before=nsis.nsisIdentity(file,options);
  fs.writeFileSync(file,installer({conditionalOverwrite:true,relocated:true}));
  assert.notDeepEqual(nsis.nsisIdentity(file,options),before,'conditional overwrite timestamps affect runtime behavior');
}));
test('unknown NSIS layouts fail before accepting a source proof', () => fixture(dir => {
  const file=path.join(dir,'setup.exe'), bytes=installer();bytes[512+4]^=1;fs.writeFileSync(file,bytes);
  assert.throws(()=>nsis.nsisIdentity(file,{payloads:{},applicationSize:1024}),/Missing NSIS/);
}));
