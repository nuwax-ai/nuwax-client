/** Windows ICO：保留品牌图案，缩小透明留白，让任务栏有效图形放大约 42/39。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json'));
const sharp = require('sharp');
const publicDir = path.join(root, 'overlay/crates/agent-electron-client/public');
const sizes = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256];
const frames = [];

for (const size of sizes) {
  // 原 ICO 有效图形约占 90%；放大 42/39 后约占 97%。
  const contentSize = Math.min(size, Math.round(size * 0.9 * 42 / 39));
  const padding = Math.floor((size - contentSize) / 2);
  const radius = contentSize * 0.2;
  const mask = Buffer.from(`<svg width="${contentSize}" height="${contentSize}"><rect width="${contentSize}" height="${contentSize}" rx="${radius}" fill="white"/></svg>`);
  const content = await sharp(path.join(publicDir, 'icon.png'))
    .resize(contentSize, contentSize)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png().toBuffer();
  const rgba = await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([{ input: content, left: padding, top: padding }])
    .raw().toBuffer();

  // ICO 使用 32 位 DIB + AND mask，与原文件编码保持一致，覆盖各 DPI 所需尺寸。
  const maskStride = Math.ceil(size / 32) * 4;
  const bitmap = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(size, 4);
  bitmap.writeInt32LE(size * 2, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  bitmap.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dest = 40 + ((size - 1 - y) * size + x) * 4;
      bitmap[dest] = rgba[src + 2];
      bitmap[dest + 1] = rgba[src + 1];
      bitmap[dest + 2] = rgba[src];
      bitmap[dest + 3] = rgba[src + 3];
      if (rgba[src + 3] === 0) {
        const maskOffset = 40 + size * size * 4 + (size - 1 - y) * maskStride + Math.floor(x / 8);
        bitmap[maskOffset] |= 1 << (7 - x % 8);
      }
    }
  }
  frames.push({ size, bitmap });
}

const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, bitmap }, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bitmap.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += bitmap.length;
});
await fs.writeFile(path.join(publicDir, 'icon.ico'), Buffer.concat([header, ...frames.map(({ bitmap }) => bitmap)]));
console.log(`Windows icon generated: ${sizes.join(', ')} px`);
