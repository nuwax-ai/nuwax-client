const fs = require('node:fs');
const path = require('node:path');
const { zstdDecompressSync } = require('node:zlib');

function readSessionRows(home) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.jsonl(\.zstd)?$/.test(entry.name)) files.push(file);
    }
  }
  visit(path.join(home, 'sessions'));
  function decompress(data) {
    const chunks = []; let offset = 0;
    // Node 24.21 consumes a single frame; later Node versions consume all frames.
    while (offset < data.length) {
      const result = zstdDecompressSync(data.subarray(offset), { info: true });
      if (!result.engine.bytesWritten) throw new Error('Zstandard made no progress');
      chunks.push(result.buffer); offset += result.engine.bytesWritten;
    }
    return Buffer.concat(chunks);
  }
  return files.map(file => {
    const data = fs.readFileSync(file);
    return (file.endsWith('.zstd') ? decompress(data) : data).toString().split('\n').filter(Boolean).map(value => JSON.stringify(JSON.parse(value)));
  });
}
module.exports = { readSessionRows };
