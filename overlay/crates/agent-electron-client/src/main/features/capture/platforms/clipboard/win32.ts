import path from 'node:path';
import type { RunClipboardCommand } from './types';

// SetFileDropList 产生标准 CF_HDROP；-STA 满足 Windows 剪贴板线程要求。
// 文件路径从 JSON stdin 读取，含引号/反引号/美元符号也不会作为代码执行。
const SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$capturePath = [Console]::In.ReadToEnd() | ConvertFrom-Json
$captureFiles = New-Object System.Collections.Specialized.StringCollection
[void]$captureFiles.Add([string]$capturePath)
[System.Windows.Forms.Clipboard]::SetFileDropList($captureFiles)
`;
export const WINDOWS_CLIPBOARD_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');

export function windowsClipboardExecutable(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
export function createWindowsFileClipboard(run: RunClipboardCommand, executable = windowsClipboardExecutable()) {
  return (filePath: string, signal: AbortSignal) => run({
    executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', WINDOWS_CLIPBOARD_SCRIPT],
    input: JSON.stringify(filePath),
  }, signal);
}
