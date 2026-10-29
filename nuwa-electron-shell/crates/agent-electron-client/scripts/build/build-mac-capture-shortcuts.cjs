const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function buildMacCaptureShortcuts(root, platform = process.platform) {
  const output = path.join(root, 'dist/main/mac-capture-shortcuts.node');
  if (platform !== 'darwin') { fs.rmSync(output, { force: true }); return; }
  const headers = require('node-api-headers').include_dir;
  const sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const source = path.join(root, 'native/mac-capture-shortcuts.mm');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-capture-hotkeys-'));
  try {
    const slices = ['arm64', 'x86_64'].map(arch => {
      const file = path.join(temporary, `${arch}.node`);
      execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++', '-isysroot', sdk,
        '-arch', arch, '-mmacosx-version-min=12.0', '-std=c++17', '-DNAPI_VERSION=8', '-O2',
        '-bundle', '-undefined', 'dynamic_lookup', '-I', headers, '-framework', 'Carbon', source, '-o', file], { stdio: 'inherit' });
      return file;
    });
    const universal = path.join(temporary, 'universal.node');
    execFileSync('/usr/bin/lipo', ['-create', ...slices, '-output', universal], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', universal], { stdio: 'inherit' });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(universal, output);
    console.log('[build:main] macOS exclusive capture shortcut addon ready (arm64+x64)');
    return output;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { buildMacCaptureShortcuts };
if (require.main === module) buildMacCaptureShortcuts(path.resolve(__dirname, '../..'));
