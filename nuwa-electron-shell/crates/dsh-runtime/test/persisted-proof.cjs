const fs = require('node:fs');
const path = require('node:path');
const { zstdDecompressSync } = require('node:zlib');
const files = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.jsonl(\.zstd)?$/.test(entry.name)) files.push(file);
  }
}
visit(path.join(process.argv[2], 'sessions'));
let passed = false;
let toolCalls = 0;
function decompress(data) { const chunks=[];let offset=0;while(offset<data.length){const result=zstdDecompressSync(data.subarray(offset),{info:true});if(!result.engine.bytesWritten)throw new Error('Zstandard made no progress');chunks.push(result.buffer);offset+=result.engine.bytesWritten;}return Buffer.concat(chunks); }
for (const file of files) {
  const data = fs.readFileSync(file);
  const rows = (file.endsWith('.zstd') ? decompress(data) : data).toString().split('\n').filter(Boolean).map(value => JSON.stringify(JSON.parse(value)));
  const call = rows.findIndex(value => value.includes('tool/call') && value.includes('list_bots'));
  const result = rows.findIndex((value, index) => index > call && value.includes('tool/result'));
  if (call >= 0) toolCalls++;
  if (call >= 0 && result > call && rows.some((value, index) => index > result && value.includes('assistant/message') && value.includes('DSH_PLATFORM_OK'))) passed = true;
}
console.log(JSON.stringify({ passed, sessionFiles: files.length, toolCalls }));
