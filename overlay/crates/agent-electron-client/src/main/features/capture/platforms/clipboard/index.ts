import { clipboard, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { createMacFileClipboard } from './darwin';
import { createWindowsFileClipboard, windowsClipboardExecutable } from './win32';
import { createLinuxFileClipboard } from './linux';
import { runClipboardCommand } from './command';
import type { CaptureClipboardPlatform } from './types';

export function canCopyCaptureFiles(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin') return existsSync('/usr/bin/osascript');
  if (platform === 'win32') return existsSync(windowsClipboardExecutable());
  return platform === 'linux';
}

export function createCaptureClipboardPlatform(platform: NodeJS.Platform = process.platform): CaptureClipboardPlatform {
  const writeFile = platform === 'darwin' ? createMacFileClipboard(runClipboardCommand)
    : platform === 'win32' ? createWindowsFileClipboard(runClipboardCommand)
    : platform === 'linux' ? createLinuxFileClipboard((format, data) => clipboard.writeBuffer(format, data))
    : async () => { throw new Error('file clipboard is not supported'); };
  return {
    canCopyFiles: canCopyCaptureFiles(platform),
    writeImage(filePath) {
      const image = nativeImage.createFromPath(filePath);
      if (image.isEmpty()) throw new Error('capture image could not be decoded');
      clipboard.writeImage(image);
    },
    writeFile,
  };
}
