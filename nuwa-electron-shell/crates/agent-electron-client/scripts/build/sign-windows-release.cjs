'use strict';

// Repackage the exact CI payload, never rebuild the application on the signing
// machine. All inputs, including installer sources, are pinned by the CI manifest.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const signing = require('./windows-signing.cjs');

function execute(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}
const windowsPath = value => value?.replace(/^\/([a-z])\//i, (_, drive) => drive.toUpperCase() + ':/');
function signTool() {
  let candidate = windowsPath(process.env.SIGNTOOL_PATH);
  if (candidate) {
    if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'signtool.exe');
    assert(fs.existsSync(candidate), 'Invalid SIGNTOOL_PATH'); return candidate;
  }
  candidate = path.join(process.env.USERPROFILE || '', 'signtool', 'signtool.exe');
  if (fs.existsSync(candidate)) return candidate;
  const tool = require('./sign-win.js').findSigntool();
  assert(tool, 'signtool is required'); return tool;
}
function signFiles(files, { work, tool, verifyOnly = false, force = [] }) {
  const plan = path.join(work, 'signature-files.json');
  fs.writeFileSync(plan, JSON.stringify({ files, force }));
  try {
    execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'sign-windows-files.ps1'), '-FilesJson', plan, '-SignTool', tool, ...(verifyOnly ? ['-VerifyOnly'] : [])]);
  } finally { fs.rmSync(plan, { force: true }); }
}
function codeFiles(root) {
  return signing.filesIn(root).filter(name => /\.ps1$/i.test(name) || signing.peIdentity(fs.readFileSync(path.join(root, name))))
    .map(name => path.join(root, name));
}
function nsisSigningFiles(root) {
  // Stubs are linker inputs. Signing them before makensis rewrites/appends the
  // payload leaves a stale PE certificate directory in the generated EXE.
  // Sign runtime plugins/tools here; sign generated installers via the hook.
  return codeFiles(root).filter(file => !/^Stubs\//i.test(path.relative(root, file).split(path.sep).join('/')));
}
function safeRecipePath(name) {
  assert(/^(build\/[\w./-]+\.(nsh|ps1|ico|bmp)|public\/icon\.ico|scripts\/build\/uninstall-payload\.cjs)$/.test(name)
    && !name.split('/').includes('..'), 'Unsafe installer recipe path');
}
function installerSignHook(application, sign) {
  const mainHash = signing.hashFile(application);
  return async ({ path: file }) => {
    const isApplication = path.basename(file) === 'Nuwax.exe';
    if (isApplication) assert.equal(signing.hashFile(file), mainHash, 'Application changed after uninstall inventory was generated');
    // Re-signing the application now would invalidate the uninstall inventory.
    sign(file, { verifyOnly: isApplication });
  };
}
async function repackage(input, unsigned, work, tool) {
  assert.equal(signing.hashFile(unsigned), input.unsignedSha256, 'Unsigned installer differs from CI');
  const stage = path.join(work, 'payload');
  let extracted;
  if (fs.existsSync(path.join(stage, 'app/Nuwax.exe'))) extracted = { app: path.join(stage, 'app') };
  else {
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage);
    extracted = signing.unpack(unsigned, stage);
  }
  // SimplySign authentication may expire halfway through a batch. Resume only
  // after checking every cached code body against CI, never against that cache.
  signing.verifyTree(extracted.app, input.application, { resourceDigests: true, requireSignatures: false });
  fs.rmSync(path.join(stage, 'project'), { recursive: true, force: true });
  fs.rmSync(path.join(stage, 'builder-cache'), { recursive: true, force: true });
  fs.rmSync(path.join(stage, 'output'), { recursive: true, force: true });
  const project = path.join(stage, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ ...input.package, private: true }));
  for (const [name, encoded] of Object.entries(input.recipe)) {
    safeRecipePath(name); const file = path.join(project, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(encoded, 'base64'));
  }
  const dependencies = path.join(work, 'packager'); fs.mkdirSync(dependencies, { recursive: true });
  const requireBuilder = createRequire(path.join(dependencies, 'package.json'));
  try { assert.equal(requireBuilder('electron-builder/package.json').version, signing.BUILDER_VERSION); }
  catch {
    const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const args = ['install', '--prefix', dependencies, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `electron-builder@${signing.BUILDER_VERSION}`];
    assert(fs.existsSync(npm), 'The Node.js npm CLI is required');
    execute(process.execPath, [npm, ...args]);
  }
  assert.equal(requireBuilder('electron-builder/package.json').version, signing.BUILDER_VERSION);
  // Private tool caches only: signing NSIS plugins must not mutate shared SDKs.
  process.env.ELECTRON_BUILDER_CACHE = path.join(stage, 'builder-cache');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  delete process.env.NSIS_PATH;
  const { NSIS_PATH, NsisTargetOptions } = requireBuilder('app-builder-lib/out/targets/nsis/nsisUtil');
  const { getBinFromUrl } = requireBuilder('app-builder-lib/out/binDownload');
  NsisTargetOptions.resolve({});
  const nsis = await NSIS_PATH();
  assert.equal(path.basename(nsis), 'nsis-3.0.4.1', 'Review signing recipe for a new NSIS toolchain');
  const resources = await getBinFromUrl('nsis-resources', '3.4.1', 'Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==');
  signFiles(codeFiles(extracted.app).concat(codeFiles(project), nsisSigningFiles(nsis), nsisSigningFiles(resources)),
    { work, tool, force: [path.join(extracted.app, 'Nuwax.exe')] });
  signing.refreshResourceDigests(extracted.app, input.application);
  signing.verifyTree(extracted.app, input.application, { resourceDigests: true });
  const { writeUninstallPayload } = require(path.join(project, 'scripts/build/uninstall-payload.cjs'));
  writeUninstallPayload({ packager: { appInfo: { name: 'nuwax', productFilename: 'Nuwax' }, projectDir: project }, appOutDir: extracted.app, arch: 1 });
  const output = path.join(stage, 'output'), original = input.config;
  const config = { appId: original.appId, productName: original.productName, copyright: original.copyright,
    electronVersion: input.electronVersion, npmRebuild: false, forceCodeSigning: true,
    extraMetadata: { ...original.extraMetadata, name: 'nuwax', productName: 'Nuwax' },
    directories: { output, buildResources: path.join(project, 'build') }, files: [], extraResources: [],
    publish: original.publish, compression: 'normal', detectUpdateChannel: false,
    win: { ...original.win, target: ['nsis'], extraResources: [], icon: path.join(project, 'public/icon.ico'),
      signingHashAlgorithms: ['sha256'], signDlls: false, signAndEditExecutable: true,
      sign: installerSignHook(path.join(extracted.app, 'Nuwax.exe'), (file, options) => signFiles([file], { work, tool, force: [file], ...options })) },
    nsis: { ...original.nsis, include: path.join(project, 'build/installer.nsh'),
      useZip: input.useZip, differentialPackage: false, packElevateHelper: false,
      artifactName: 'Nuwax.Setup.${version}.${ext}' } };
  const { build, Platform, Arch } = requireBuilder('app-builder-lib');
  await build({ projectDir: project, prepackaged: extracted.app, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never', config });
  return path.join(output, `Nuwax.Setup.${input.package.version}.exe`);
}
async function main(args = process.argv.slice(2)) {
  assert.equal(process.platform, 'win32', 'Windows package signing/verification must run on Windows');
  const version = args.find(arg => !arg.startsWith('-'));
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'A stable version is required');
  const tag = process.env.SIGN_RELEASE_TAG || `v${version}`, repo = process.env.SIGN_RELEASE_REPO || 'nuwax-ai/nuwax-client';
  assert([`v${version}`, `electron-v${version}`].includes(tag), 'Signing tag/version mismatch');
  const work = path.resolve(windowsPath(process.env.SIGN_WORK_DIR) || path.join(process.env.TEMP || '.', 'nuwax-sign', tag));
  fs.mkdirSync(work, { recursive: true }); const tool = signTool(); signing.archiveTool();
  const gh = windowsPath(process.env.GH_BIN) || 'gh';
  const download = (name, folder = work) => execute(gh, ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', folder, '--clobber']);
  const manifestFile = path.join(work, 'build-manifest-windows-x64.json'); download(path.basename(manifestFile));
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  assert.equal(manifest.tag, tag); assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.source.client, process.env.SIGN_SOURCE_SHA || manifest.source.client);
  const bundle = manifest.windowsSigning?.input;
  assert(bundle?.name === signing.INPUT_NAME, 'This CI build lacks inner signing inputs; rebuild before signing');
  assert.equal(manifest.artifacts[bundle.name], bundle.sha256, 'Signing input is not anchored in CI artifacts');
  assert.equal(bundle.sha256, process.env.SIGN_INPUT_SHA256 || bundle.sha256, 'Unexpected CI signing input');
  const inputFile = path.join(work, bundle.name);
  if (!fs.existsSync(inputFile) || signing.hashFile(inputFile) !== bundle.sha256) download(bundle.name);
  const input = signing.readInput(inputFile, { sha256: bundle.sha256, tag, source: manifest.source });
  assert.equal(input.package.version, version);
  assert.equal(input.unsignedSha256, manifest.artifacts[`Nuwax-Setup-${version}-unsigned.exe`]);
  const signed = path.join(work, 'signed'); fs.mkdirSync(signed, { recursive: true });
  const installer = path.join(signed, `Nuwax.Setup.${version}.exe`);
  if (!args.includes('--upload-only')) {
    const unsignedDir = path.join(work, 'unsigned'); fs.mkdirSync(unsignedDir, { recursive: true });
    const unsigned = path.join(unsignedDir, `Nuwax-Setup-${version}-unsigned.exe`);
    if (!fs.existsSync(unsigned) || signing.hashFile(unsigned) !== input.unsignedSha256) {
      assert(!args.includes('--skip-download'), 'Cached unsigned installer does not match CI'); download(path.basename(unsigned), unsignedDir);
    }
    fs.copyFileSync(await repackage(input, unsigned, work, tool), installer);
  }
  // Upload-only is subject to the same actual-package verification as signing.
  const report = signing.verifyPackage(installer, input, { verifySignatures: files => signFiles(files, { work, tool, verifyOnly: true,
    force: files.filter(file => ['Nuwax.exe', 'Uninstall Nuwax.exe', path.basename(installer)].includes(path.basename(file))) }) });
  report.inputSha256 = bundle.sha256;
  const reportFile = path.join(signed, signing.REPORT_NAME); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (!args.includes('--skip-upload')) {
    execute(gh, ['release', 'upload', tag, installer, reportFile, '--clobber', '--repo', repo]);
    // Keep CI inputs until both verified outputs are uploaded successfully.
    const assets = JSON.parse(execute(gh, ['release', 'view', tag, '--json', 'assets', '--repo', repo], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })).assets;
    for (const name of [`Nuwax-Setup-${version}-unsigned.exe`, `Nuwax-Setup-${version}-unsigned.exe.blockmap`]) {
      if (assets.some(asset => asset.name === name)) execute(gh, ['release', 'delete-asset', tag, name, '--yes', '--repo', repo]);
    }
  }
  console.log(JSON.stringify(report));
}
module.exports = { safeRecipePath, installerSignHook, codeFiles, nsisSigningFiles, signFiles, repackage, main };
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
