import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLIBC_LIMIT,
  TARGET_ARCH,
  TARGET_PLATFORM,
  UNIT_NAME,
  buildEnv,
  checkNativeModule,
  checkTargetPlatform,
  systemdRunArgs,
} from './client/dev-uos.mjs';

test('the UOS entry point refuses to run on anything but Linux arm64', () => {
  assert.deepEqual(checkTargetPlatform('linux', 'arm64'), { ok: true });
  const wrongPlatform = checkTargetPlatform('darwin', 'arm64');
  assert.equal(wrongPlatform.ok, false);
  assert.match(wrongPlatform.reason, /linux/);
  const wrongArch = checkTargetPlatform('linux', 'x64');
  assert.equal(wrongArch.ok, false);
  assert.match(wrongArch.reason, /arm64/);
  assert.equal(TARGET_PLATFORM, 'linux');
  assert.equal(TARGET_ARCH, 'arm64');
});

test('the launch environment isolates the profile and keeps the sandbox', () => {
  const env = buildEnv({ PATH: '/usr/bin', HOME: '/home/ABC' }, { nodeDir: '/opt/Nuwax/resources/node/linux-arm64/bin' });
  assert.equal(env.NUWAX_DEV_PROFILE, '1');
  assert.equal(env.NUWAX_DEV_KEEP_SANDBOX, '1');
  assert.equal(env.HOME, '/home/ABC');
  const entries = env.PATH.split(path.delimiter);
  assert.equal(entries[0], '/opt/Nuwax/resources/node/linux-arm64/bin');
  assert.equal(entries[1], '/home/ABC/.local/bin');
  assert.ok(entries.includes('/usr/bin'));
});

test('the native module check reports a missing module and a too-new glibc requirement', () => {
  const missing = checkNativeModule('/nonexistent/better_sqlite3.node', GLIBC_LIMIT);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /不存在/);
});

test('the glibc limit matches the UOS 1050 target', () => {
  assert.equal(GLIBC_LIMIT, '2.28');
});

test('the client starts as a systemd user unit so it inherits the graphical session', () => {
  const args = systemdRunArgs({ workingDirectory: '/home/ABC/nuwax-dev', logFile: '/home/ABC/nuwax-dev-logs/dev.log', env: { PATH: '/opt/Nuwax/resources/node/linux-arm64/bin' } });
  assert.ok(args.includes(`--unit=${UNIT_NAME}`));
  assert.ok(args.includes('--working-directory=/home/ABC/nuwax-dev'));
  assert.ok(args.includes('--collect'));
  assert.ok(args.includes('--setenv=NUWAX_DEV_PROFILE=1'));
  assert.ok(args.includes('--setenv=NUWAX_DEV_KEEP_SANDBOX=1'));
  assert.ok(args.includes('StandardOutput=append:/home/ABC/nuwax-dev-logs/dev.log'));
  // 单元不继承调用方环境，PATH 必须显式传过去。
  assert.ok(args.includes('--setenv=PATH=/opt/Nuwax/resources/node/linux-arm64/bin'));
});
