import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = new URL('./release-stable.sh', import.meta.url);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-stable-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  mkdirSync(work);
  mkdirSync(bin);
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'release-test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  writeFileSync(join(work, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'release-test');
  mkdirSync(join(work, 'release-notes'));
  writeFileSync(join(work, 'release-notes', 'electron-v1.0.32.md'), 'release notes\n');
  const script = fileURLToPath(source);
  // Only local Git is real in this fixture. The fake CLI stops the script before
  // any Release lookup or workflow dispatch; the remote is a temporary bare repo.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const run = () => spawnSync('bash', [script, '1.0.32', '--notes'], {
    cwd: work, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { root, work, remote, bin, script, git, run };
}

test('--notes commits and pushes only the requested untracked release note', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, 'nuwa-electron-shell'), 'excluded base fixture\n');
    f.git('add', 'nuwa-electron-shell');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未找到.*workflow run/);
    assert.equal(f.git('show', 'HEAD:release-notes/electron-v1.0.32.md'), 'release notes');
    assert.equal(f.git('ls-remote', 'origin', 'refs/heads/release-test').split(/\s/)[0], f.git('rev-parse', 'HEAD'));
    assert.equal(f.git('ls-remote', 'origin', 'refs/tags/electron-v1.0.32').split(/\s/)[0], f.git('rev-parse', 'HEAD'));
    assert.equal(f.git('ls-tree', '--name-only', 'HEAD', 'nuwa-electron-shell'), '');
    assert.equal(f.git('diff', '--cached', '--name-only'), 'nuwa-electron-shell');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('--notes includes a note already staged, but rejects unrelated dirty files', () => {
  const f = fixture();
  try {
    f.git('add', 'release-notes/electron-v1.0.32.md');
    writeFileSync(join(f.work, 'other.txt'), 'unrelated\n');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /外层工作树有未提交改动/);
    assert.equal(f.git('rev-list', '--count', 'HEAD'), '1');
    rmSync(join(f.work, 'other.txt'));
    const second = f.run();
    assert.match(second.stderr, /未找到.*workflow run/);
    assert.equal(readFileSync(join(f.work, 'release-notes/electron-v1.0.32.md'), 'utf8'), 'release notes\n');
    assert.equal(f.git('rev-list', '--count', 'HEAD'), '2');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('resumes after signing when the Release has only the signed Windows EXE', () => {
  const f = fixture();
  try {
    f.git('add', 'release-notes/electron-v1.0.32.md');
    f.git('commit', '-qm', 'notes');
    f.git('push', '-q', 'origin', 'release-test');
    f.git('tag', 'electron-v1.0.32');
    f.git('push', '-q', 'origin', 'electron-v1.0.32');
    writeFileSync(join(f.bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  'run list') echo 42 ;;
  'run view') echo completed/success ;;
  'release view')
    case "$*" in
      *'.size'*) echo 123 ;;
      *) cat <<'ASSETS'
Nuwax-1.0.32-arm64.dmg
Nuwax-1.0.32.dmg
Nuwax-1.0.32-arm64-mac.zip
Nuwax-1.0.32.AppImage
Nuwax-1.0.32-amd64.deb
Nuwax-1.0.32-x86_64.rpm
Nuwax.Setup.1.0.32.exe
Nuwax.1.0.32.msi
latest-mac.yml
latest.yml
build-manifest-macos-arm64.json
build-manifest-macos-x64.json
build-manifest-windows-x64.json
build-manifest-linux-x64.json
build-manifest-linux-arm64.json
ASSETS
      ;;
    esac ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(f.bin, 'curl'), `#!/bin/sh
case "$1" in
  -sSI) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 123\\r\\n' ;;
  -sSf) exit 0 ;;
  *) echo '{"version":"1.0.32","platforms":{"windows-x86_64":{"url":"https://example.invalid/Nuwax.Setup.1.0.32.exe"},"darwin-aarch64-zip":{"url":"https://example.invalid/Nuwax-1.0.32-arm64-mac.zip"}}}' ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(f.bin, 'ssh'), '#!/bin/sh\necho signing-should-not-run >&2\nexit 7\n', { mode: 0o755 });
    const result = spawnSync('bash', [f.script, '1.0.32'], {
      cwd: f.work, encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /完成：electron-v1\.0\.32 stable 全链发布就绪/);
    assert.doesNotMatch(result.stderr, /signing-should-not-run/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
