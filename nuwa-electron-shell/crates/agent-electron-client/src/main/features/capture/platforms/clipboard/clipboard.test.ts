import { describe, expect, it, vi } from 'vitest';
import { createMacFileClipboard } from './darwin';
import { createWindowsFileClipboard, WINDOWS_CLIPBOARD_SCRIPT } from './win32';
import { createLinuxFileClipboard } from './linux';
import type { FileClipboardCommand } from './types';

describe('原生文件剪贴板适配', () => {
  it('macOS 文件参数不拼入代码，使用 AppKit 文件 URL', async () => {
    const run = vi.fn(async (_command: FileClipboardCommand, _signal: AbortSignal): Promise<void> => undefined); const file = '/tmp/录屏 $() "&.mp4'; const signal = new AbortController().signal;
    await createMacFileClipboard(run)(file, signal);
    const command = run.mock.calls[0][0];
    expect(command.executable).toBe('/usr/bin/osascript');
    expect(command.args.at(-1)).toBe(file); expect(command.args[3]).not.toContain(file);
    expect(command.args[3]).toContain('writeObjects'); expect(run.mock.calls[0][1]).toBe(signal);
  });
  it('Windows 使用 STA/标准 FileDrop，路径通过 JSON stdin 传递', async () => {
    const run = vi.fn(async (_command: FileClipboardCommand, _signal: AbortSignal): Promise<void> => undefined); const file = 'C:\\tmp\\录屏 $() ` & "😀.gif';
    await createWindowsFileClipboard(run, 'C:\\Windows\\powershell.exe')(file, new AbortController().signal);
    const command = run.mock.calls[0][0];
    expect(command.args).toContain('-STA'); expect(command.args).toContain('-EncodedCommand');
    expect(JSON.parse(command.input!)).toBe(file); expect(command.args.join(' ')).not.toContain(file);
    expect(Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, 'base64').toString('utf16le')).toContain('SetFileDropList');
  });
  it('Linux 使用可正确解码的 file URI，取消不写剪贴板', async () => {
    const write = vi.fn(); const copy = createLinuxFileClipboard(write);
    await copy('/tmp/录屏 #&.mp4', new AbortController().signal);
    expect(write.mock.calls[0][0]).toBe('text/uri-list');
    expect(decodeURIComponent(write.mock.calls[0][1].toString().trim())).toBe('file:///tmp/录屏 #&.mp4');
    const aborted = new AbortController(); aborted.abort();
    await expect(copy('/tmp/video.gif', aborted.signal)).rejects.toThrow('canceled'); expect(write).toHaveBeenCalledOnce();
  });
});
