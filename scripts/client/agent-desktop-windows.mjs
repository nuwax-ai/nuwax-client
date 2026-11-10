/** Build the pinned Windows backend with UIA's implicit focus changes disabled. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const revision = '2b0a7334fc111730454b726e6800aa41cdafc093';
const source = `https://codeload.github.com/vercel-labs/agent-desktop/tar.gz/${revision}`;
const archiveSha256 = 'b8e5c536ba6e66f2e82b6863c198e06f1d11fcdfc100d44de0a871a38a82dc7f';
const toolchain = '1.97.1';
const patchPath = 'third-party/patches/agent-desktop-windows-no-focus.patch';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const verifyWindowsDesktopSource = bytes => {
  if (bytes.length > 64 * 1024 * 1024 || sha256(bytes) !== archiveSha256) throw new Error('Agent Desktop source integrity mismatch');
};

export function windowsDesktopRecipe(root, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Agent Desktop Windows architecture');
  return sha256(JSON.stringify({ revision, archiveSha256, toolchain, arch,
    script: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    patch: sha256(fs.readFileSync(path.join(root, patchPath))) }));
}

export async function buildWindowsDesktop(root, destination, { arch = process.arch } = {}) {
  if (process.platform !== 'win32' || arch !== process.arch) throw new Error('Agent Desktop Windows build requires a matching Windows runner');
  const recipe = windowsDesktopRecipe(root, arch);
  const cache = path.join(root, '.cache/agent-desktop-windows');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `${revision}.tar.gz`);
  if (!fs.existsSync(archive)) {
    const partial = archive + '.part';
    try {
      await exec('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2',
        '--max-time', '180', '--max-filesize', String(64 * 1024 * 1024), '--output', partial, source], { timeout: 200_000 });
      verifyWindowsDesktopSource(fs.readFileSync(partial));
      fs.renameSync(partial, archive);
    } finally { fs.rmSync(partial, { force: true }); }
  }
  verifyWindowsDesktopSource(fs.readFileSync(archive));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-desktop-windows-'));
  const target = `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`;
  try {
    // Absolute drive-letter archives must go through Windows' BSD tar.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe');
    await exec(tar, ['-xzf', archive, '-C', stage, '--strip-components=1']);
    const patch = path.join(root, patchPath);
    await exec('git', ['apply', '--check', patch], { cwd: stage });
    await exec('git', ['apply', patch], { cwd: stage });
    // MSVC's linker still rejects long output paths even when Node accepts them.
    // Keep Cargo's nested build-script paths outside a possibly deep checkout.
    const targetDir = path.join(os.tmpdir(), 'nuwax-ad-build', recipe.slice(0, 20));
    console.log('[agent-desktop] Building pinned Windows source with no-focus patch');
    await exec('cargo', [`+${toolchain}`, 'build', '--locked', '--release', '-p', 'agent-desktop', '--target', target, '--target-dir', targetDir],
      { cwd: stage, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    const binary = path.join(targetDir, target, 'release/agent-desktop.exe');
    if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink() || fs.statSync(binary).size === 0)
      throw new Error('Agent Desktop Windows build did not produce a regular binary');
    const { stdout } = await exec(binary, ['--version']);
    if (stdout.trim() !== 'agent-desktop 1.2.0') throw new Error('Agent Desktop Windows build version mismatch');
    fs.copyFileSync(binary, destination);
    return { recipe, source, revision, archiveSha256, toolchain, target, patch: patchPath, patchSha256: sha256(fs.readFileSync(patch)) };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
