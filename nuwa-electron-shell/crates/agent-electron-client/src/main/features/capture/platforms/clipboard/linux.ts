import { pathToFileURL } from 'node:url';

/** GTK/GDK、Qt 及 Chromium 使用标准 URI 列表识别文件粘贴。 */
export function createLinuxFileClipboard(writeBuffer: (format: string, buffer: Buffer) => void) {
  return async (filePath: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw new Error('clipboard copy canceled');
    writeBuffer('text/uri-list', Buffer.from(`${pathToFileURL(filePath).href}\r\n`, 'utf8'));
  };
}
