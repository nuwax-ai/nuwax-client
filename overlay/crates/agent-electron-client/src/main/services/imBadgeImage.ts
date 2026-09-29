import { deflateSync } from "node:zlib";

const BADGE_SIZE = 16;
const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "010", "010", "111"],
  "2": ["111", "001", "001", "111", "100", "100", "111"],
  "3": ["111", "001", "001", "111", "001", "001", "111"],
  "4": ["101", "101", "101", "111", "001", "001", "001"],
  "5": ["111", "100", "100", "111", "001", "001", "111"],
  "6": ["111", "100", "100", "111", "101", "101", "111"],
  "7": ["111", "001", "001", "010", "010", "010", "010"],
  "8": ["111", "101", "101", "111", "101", "101", "111"],
  "9": ["111", "101", "101", "111", "001", "001", "111"],
  "+": ["000", "000", "010", "111", "010", "000", "000"],
};

export function normalizeIMUnreadCount(count: number): number {
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function formatIMBadgeCount(count: number): string {
  const normalized = normalizeIMUnreadCount(count);
  return normalized === 0 ? "" : normalized > 99 ? "99+" : String(normalized);
}

function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, "ascii");
  const contents = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, contents, checksum]);
}

/** 本地绘制透明 PNG，避开 SVG 解码和平台相关 bitmap 字节序。 */
export function createIMBadgePng(count: number): Buffer {
  const label = formatIMBadgeCount(count);
  const pixels = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4);
  const paint = (x: number, y: number, red: number, green: number, blue: number): void => {
    const offset = (y * BADGE_SIZE + x) * 4;
    pixels.set([red, green, blue, 255], offset);
  };
  if (label) {
    for (let y = 0; y < BADGE_SIZE; y += 1) {
      for (let x = 0; x < BADGE_SIZE; x += 1) {
        if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 7.5 ** 2) paint(x, y, 230, 41, 57);
      }
    }
    const scale = label.length === 1 ? 2 : 1;
    const width = (label.length * 4 - 1) * scale;
    const left = Math.floor((BADGE_SIZE - width) / 2);
    const top = Math.floor((BADGE_SIZE - GLYPHS["0"].length * scale) / 2);
    [...label].forEach((character, index) => {
      GLYPHS[character].forEach((row, y) => {
        [...row].forEach((pixel, x) => {
          if (pixel !== "1") return;
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              paint(left + (index * 4 + x) * scale + dx, top + y * scale + dy, 255, 255, 255);
            }
          }
        });
      });
    });
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(BADGE_SIZE, 0);
  header.writeUInt32BE(BADGE_SIZE, 4);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA
  const scanlines = Buffer.alloc(BADGE_SIZE * (BADGE_SIZE * 4 + 1));
  for (let y = 0; y < BADGE_SIZE; y += 1) {
    pixels.copy(scanlines, y * (BADGE_SIZE * 4 + 1) + 1, y * BADGE_SIZE * 4, (y + 1) * BADGE_SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
