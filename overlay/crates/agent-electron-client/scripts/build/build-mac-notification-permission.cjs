// Node-API 保持 Node/Electron ABI 兼容；universal 产物供 arm64/x64 发布共用。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function buildMacNotificationPermission(root, platform = process.platform) {
  const output = path.join(root, 'dist/main/mac-notification-permission.node');
  if (platform !== 'darwin') {
    fs.rmSync(output, { force: true });
    return;
  }
  const headers = require('node-api-headers').include_dir;
  // 明确选择当前 Xcode 对应的 SDK，避免 CLT SDK 与编译器版本错配。
  const sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const source = path.join(root, 'native/mac-notification-permission.mm');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-notification-build-'));
  try {
    const slices = ['arm64', 'x86_64'].map((arch) => {
      const slice = path.join(temp, `${arch}.node`);
      execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++', '-isysroot', sdk, '-arch', arch, '-mmacosx-version-min=12.0',
        '-std=c++17', '-fobjc-arc', '-fblocks', '-DNAPI_VERSION=8', '-O2',
        '-bundle', '-undefined', 'dynamic_lookup', '-I', headers,
        '-framework', 'Foundation', '-framework', 'UserNotifications', source, '-o', slice], { stdio: 'inherit' });
      return slice;
    });
    const universal = path.join(temp, 'universal.node');
    execFileSync('/usr/bin/lipo', ['-create', ...slices, '-output', universal], { stdio: 'inherit' });
    // 本地 Electron 可装载；发布包由 electron-builder 使用应用签名重新签署。
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', universal], { stdio: 'inherit' });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(universal, output);
    console.log('[build:main] macOS notification permission addon ready (arm64+x64)');
    return output;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { buildMacNotificationPermission };
if (require.main === module) buildMacNotificationPermission(path.resolve(__dirname, '../..'));
