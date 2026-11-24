const path = require('node:path');
const { execFileSync } = require('node:child_process');

function extractWindowsZip(archivePath, outDir) {
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const options = { stdio: 'inherit' };
  try {
    // PATH 可能优先命中 Git Bash 的 GNU tar，它会把盘符当成远程主机。
    execFileSync(path.join(system32, 'tar.exe'), ['-xf', archivePath, '-C', outDir], options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    // 兼容缺少系统 tar.exe 的 Windows。直接使用 .NET Framework 的双参数 API。
    execFileSync(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(archivePath)}, ${quote(outDir)})`,
    ], options);
  }
}

module.exports = { extractWindowsZip };
