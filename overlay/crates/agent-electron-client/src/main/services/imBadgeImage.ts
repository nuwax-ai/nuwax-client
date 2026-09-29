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

/** 在 Windows NativeImage.toBitmap() 的 BGRA 位图上绘制右上角未读角标。 */
export function paintWindowsTrayBadgeBitmap(base: Buffer, count: number, pixelScale: 1 | 2): Buffer {
  const size = BADGE_SIZE * pixelScale;
  if (base.length !== size * size * 4) {
    throw new Error(`Invalid Windows tray bitmap size: ${base.length}`);
  }
  const result = Buffer.from(base);
  const label = formatIMBadgeCount(count);
  if (!label) return result;

  const glyphWidth = label.length * 4 - 1;
  const badgeWidth = Math.max(9, glyphWidth + 4);
  const badgeLeft = BADGE_SIZE - badgeWidth;
  const paint = (x: number, y: number, blue: number, green: number, red: number): void => {
    for (let dy = 0; dy < pixelScale; dy += 1) {
      for (let dx = 0; dx < pixelScale; dx += 1) {
        const offset = ((y * pixelScale + dy) * size + x * pixelScale + dx) * 4;
        result.set([blue, green, red, 255], offset);
      }
    }
  };

  // 9px 高的圆角红底最多占据右上角，应用图标的下半部分始终可见。
  const radius = 4.5;
  for (let y = 0; y < 9; y += 1) {
    for (let x = badgeLeft; x < BADGE_SIZE; x += 1) {
      const nearestX = Math.max(badgeLeft + radius, Math.min(x + 0.5, BADGE_SIZE - radius));
      const distance = (x + 0.5 - nearestX) ** 2 + (y + 0.5 - radius) ** 2;
      if (distance <= radius ** 2) paint(x, y, 57, 41, 230);
    }
  }

  const glyphLeft = badgeLeft + Math.floor((badgeWidth - glyphWidth) / 2);
  [...label].forEach((character, index) => {
    GLYPHS[character].forEach((row, y) => {
      [...row].forEach((pixel, x) => {
        if (pixel === "1") paint(glyphLeft + index * 4 + x, y + 1, 255, 255, 255);
      });
    });
  });
  return result;
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
export function createIMBadgePng(count: number, pixelScale: 1 | 2 = 1): Buffer {
  const label = formatIMBadgeCount(count);
  const imageSize = BADGE_SIZE * pixelScale;
  const pixels = Buffer.alloc(imageSize * imageSize * 4);
  const paint = (x: number, y: number, red: number, green: number, blue: number): void => {
    for (let dy = 0; dy < pixelScale; dy += 1) {
      for (let dx = 0; dx < pixelScale; dx += 1) {
        const offset = ((y * pixelScale + dy) * imageSize + x * pixelScale + dx) * 4;
        pixels.set([red, green, blue, 255], offset);
      }
    }
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
  header.writeUInt32BE(imageSize, 0);
  header.writeUInt32BE(imageSize, 4);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA
  const scanlines = Buffer.alloc(imageSize * (imageSize * 4 + 1));
  for (let y = 0; y < imageSize; y += 1) {
    pixels.copy(scanlines, y * (imageSize * 4 + 1) + 1, y * imageSize * 4, (y + 1) * imageSize * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
