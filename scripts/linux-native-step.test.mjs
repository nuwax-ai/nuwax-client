import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageHash, imageRef, imageTag, readVersions, buildArgs } from './client/linux-native-image.mjs';
import { parseStepEnv, dockerPlatform, containerHome, dockerArgs, withTimeout, runInImage, runNatively } from './client/linux-native-step.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageDir = path.join(root, 'docker/linux-native');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-linux-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A docker spy: records the argv it was called with and returns a chosen status. */
function spy(status = 0) {
  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return { status }; };
  return { spawn, calls };
}

test('the image tag is the content hash of the recipe directory', (t) => {
  const dir = temporary(t);
  for (const name of ['Dockerfile', 'versions.env', 'gxx-shim.sh']) fs.writeFileSync(path.join(dir, name), `${name}: v1\n`);
  const first = imageHash(dir);
  assert.match(first, /^[0-9a-f]{12}$/);
  // Same content, same tag: rebuilding is idempotent.
  assert.equal(imageHash(dir), first);
  assert.equal(imageRef(dir), `ghcr.io/nuwax-ai/nuwax-linux-native:${first}`);
  // Changing any recipe file changes the tag.
  fs.appendFileSync(path.join(dir, 'versions.env'), '# a comment\n');
  assert.notEqual(imageHash(dir), first);
  // A missing recipe file is an error, not a silently different tag.
  fs.rmSync(path.join(dir, 'gxx-shim.sh'));
  assert.throws(() => imageHash(dir), /缺少镜像定义文件/);
});

test('every pinned version the Dockerfile needs is declared in versions.env', () => {
  const versions = readVersions();
  const dockerfile = fs.readFileSync(path.join(imageDir, 'Dockerfile'), 'utf8');
  const consumed = [...dockerfile.matchAll(/^ARG ([A-Z][A-Z0-9_]*)$/gm)].map((match) => match[1]).filter((name) => name !== 'TARGETARCH');
  for (const name of consumed) assert.ok(versions[name], `versions.env 缺少 Dockerfile 需要的 ${name}`);
  // Every checksum looks like a SHA256; a truncated one would silently disable the check.
  for (const [name, value] of Object.entries(versions)) {
    if (name.endsWith('_SHA256') || /_SHA256_/.test(name)) assert.match(value, /^[0-9a-f]{64}$/, `${name} 不是 64 位十六进制`);
  }
  assert.equal(versions.GLIBC_FLOOR, '2.28');
  // The Rust toolchain matches the one the native build cache action pins.
  const action = fs.readFileSync(path.join(root, '.github/actions/native-build-cache/action.yml'), 'utf8');
  assert.match(action, new RegExp(`toolchain: ${versions.RUST_TOOLCHAIN.replace(/[.]/g, '\\.')}`));
});

test('build args carry every version from versions.env as --build-arg NAME=value', () => {
  const args = buildArgs({ A: '1', B: 'x=y' });
  assert.deepEqual(args, ['--build-arg', 'A=1', '--build-arg', 'B=x=y']);
  const real = buildArgs();
  const versions = readVersions();
  assert.equal(real.length, Object.keys(versions).length * 2);
  // Alternating "--build-arg" and "NAME=value" elements, in versions.env order.
  const values = real.filter((_, index) => index % 2 === 1);
  assert.deepEqual(values, Object.entries(versions).map(([name, value]) => `${name}=${value}`));
  assert.ok(real.filter((_, index) => index % 2 === 0).every((flag) => flag === '--build-arg'));
});

test('the real recipe resolves to a stable tag', () => {
  assert.match(imageTag(), /^[0-9a-f]{12}$/);
  assert.equal(imageRef(), `ghcr.io/nuwax-ai/nuwax-linux-native:${imageTag()}`);
});

test('step env text is parsed one KEY=VALUE per line, keeping equals signs inside values', () => {
  assert.deepEqual(parseStepEnv('A=1\nB=x=y\n\nignored\n  C  = spaced \n'), { A: '1', B: 'x=y', C: ' spaced ' });
  assert.deepEqual(parseStepEnv(''), {});
  assert.deepEqual(parseStepEnv(undefined), {});
});

test('the docker platform follows the repository architecture names', () => {
  assert.equal(dockerPlatform('x64'), 'linux/amd64');
  assert.equal(dockerPlatform('arm64'), 'linux/arm64');
  assert.throws(() => dockerPlatform('ia32'), /不支持的目标架构/);
});

test('the container mounts the workspace at the same path and runs as the runner user', () => {
  const args = dockerArgs({ workspace: '/home/runner/work/r/r', arch: 'arm64', uid: 1001, gid: 121, home: '/tmp/h', volumes: { '/tmp/h': '/tmp/h', '/skip/me': '' } });
  // "--flag value" is two elements; "--flag=value" is one.
  const valueOf = (flag) => {
    const inline = args.find((item) => item.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  assert.equal(valueOf('--volume'), '/home/runner/work/r/r:/home/runner/work/r/r');
  assert.equal(valueOf('--user'), '1001:121');
  assert.equal(valueOf('--platform'), 'linux/arm64');
  assert.equal(valueOf('--workdir'), '/home/runner/work/r/r');
  assert.equal(valueOf('--env'), 'HOME=/tmp/h');
  // The shim and standalone toolchains must come first, or bash finds buster's own g++ and python.
  assert.ok(args.includes('PATH=/opt/toolchain/bin:/opt/node/bin:/opt/cargo/bin:/opt/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
  assert.ok(args.includes('PYTHON=/opt/python/bin/python3.12'));
  // The image's /opt/cargo is root-owned; cargo needs a writable registry under the runner's HOME.
  const cargoHome = args.filter((item) => item.startsWith('CARGO_HOME='));
  assert.deepEqual(cargoHome, ['CARGO_HOME=/tmp/h/cargo']);
  // An empty volume source is skipped rather than mounted from the root of the host.
  assert.ok(!args.some((item) => item.startsWith('/skip/me:')));
  assert.throws(() => dockerArgs({ workspace: '/w', arch: 'x64', uid: undefined, gid: 1, home: '/h' }), /缺少 runner 的 uid\/gid/);
});

test('a step runs through bash -euo pipefail inside the image, with env and working directory applied', () => {
  const { spawn, calls } = spy();
  const code = runInImage({
    command: 'npm run rebuild:better-sqlite3', workingDirectory: 'nuwa-electron-shell/crates/agent-electron-client',
    env: { TARGET_ARCH: 'arm64', EMPTY: '' }, workspace: '/ws', arch: 'arm64', uid: 1001, gid: 121, runnerTemp: '/rt',
    ref: 'ghcr.io/nuwax-ai/nuwax-linux-native:abc', spawn,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, 'docker');
  assert.equal(options.cwd, '/ws');
  // The home directory is created under RUNNER_TEMP and mounted so pnpm/node-gyp caches survive a rerun.
  // The step's TARGET_ARCH replaces the default of the same name: exactly one occurrence.
  const targetArch = args.filter((item) => item.startsWith('TARGET_ARCH='));
  assert.deepEqual(targetArch, ['TARGET_ARCH=arm64']);
  assert.ok(args.includes('/rt/linux-native-home:/rt/linux-native-home'));
  assert.ok(!args.some((item) => item.startsWith('EMPTY=')), 'empty values are dropped');
  const workdirIndex = args.indexOf('--workdir');
  assert.equal(args[workdirIndex + 1], '/ws/nuwa-electron-shell/crates/agent-electron-client');
  // The command is handed to bash inside the image, after the image reference.
  assert.deepEqual(args.slice(-6), ['ghcr.io/nuwax-ai/nuwax-linux-native:abc', 'bash', '-euo', 'pipefail', '-c', 'npm run rebuild:better-sqlite3']);
  assert.throws(() => runInImage({ command: '   ', workspace: '/ws', arch: 'x64', uid: 1, gid: 1, runnerTemp: '/rt', spawn }), /缺少要执行的命令/);
});

test('the image exit status is passed through, so a failed build fails the step', () => {
  const { spawn } = spy(101);
  assert.equal(runInImage({ command: 'false', workspace: '/ws', arch: 'x64', uid: 1, gid: 1, runnerTemp: '/rt', ref: 'img', spawn }), 101);
});

test('on other platforms the command runs directly on the runner with the step env merged in', () => {
  const { spawn, calls } = spy();
  const code = runNatively({ command: 'npm run x', workingDirectory: 'sub', env: { FOO: 'bar', DROP: '' }, workspace: '/ws', spawn });
  assert.equal(code, 0);
  const { command, args, options } = calls[0];
  assert.equal(command, 'bash');
  assert.deepEqual(args, ['-euo', 'pipefail', '-c', 'npm run x']);
  assert.equal(options.cwd, '/ws/sub');
  assert.equal(options.env.FOO, 'bar');
  assert.ok(!('DROP' in options.env));
  assert.equal(options.env.PATH, process.env.PATH, 'the runner environment is preserved');
});

test('the container home lives under RUNNER_TEMP so it belongs to the runner user', () => {
  assert.equal(containerHome('/rt', '/ws'), path.join('/rt', 'linux-native-home'));
  assert.equal(containerHome('', '/ws'), path.join('/ws', '.tmp', 'linux-native-home'));
});

test('a step timeout wraps the command in timeout, and no limit leaves it alone', () => {
  assert.deepEqual(withTimeout(['bash', '-c', 'true'], 30), ['timeout', '--kill-after=30s', '30m', 'bash', '-c', 'true']);
  assert.deepEqual(withTimeout(['bash', '-c', 'true'], '30'), ['timeout', '--kill-after=30s', '30m', 'bash', '-c', 'true']);
  // No limit: unchanged, for empty, zero, negative and non-numeric input.
  for (const limit of ['', undefined, null, 0, -5, 'soon']) assert.deepEqual(withTimeout(['bash', '-c', 'true'], limit), ['bash', '-c', 'true']);
});

test('the timeout wraps docker itself on Linux, so a hung build is killed and the container goes with it', () => {
  const { spawn, calls } = spy(124);
  const code = runInImage({ command: 'make', workspace: '/ws', arch: 'x64', uid: 1, gid: 1, runnerTemp: '/rt', timeoutMinutes: 30, ref: 'img', spawn });
  assert.equal(code, 124);
  const { command, args } = calls[0];
  assert.equal(command, 'timeout');
  assert.deepEqual(args.slice(0, 3), ['--kill-after=30s', '30m', 'docker']);
  assert.equal(args[3], 'run');
  // Without a timeout the command is docker itself.
  const plain = spy();
  runInImage({ command: 'make', workspace: '/ws', arch: 'x64', uid: 1, gid: 1, runnerTemp: '/rt', ref: 'img', spawn: plain.spawn });
  assert.equal(plain.calls[0].command, 'docker');
});

