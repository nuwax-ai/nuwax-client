// Build a real NSIS installer with a harmless synthetic payload and a random
// product identity. It never runs the installed Nuwax application or publishes.
// node scripts/acceptance/windows-installer-recovery.cjs --output-dir <new-dir>
//   --builder <pinned electron-builder/cli.js> [--nsis-root <3.0.4.1-cache>]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const options = {};
while (args.length) {
  const key = args.shift();
  if (!['--output-dir', '--builder', '--nsis-root', '--identity-file', '--version'].includes(key) || !args.length || options[key]) throw Error('Invalid QA arguments');
  options[key] = args.shift();
}
if (!options['--output-dir'] || !options['--builder']) throw Error('Explicit new output directory and pinned builder are required');
if (process.platform !== 'win32') throw Error('Build acceptance installers on Windows: builder 25.1.8 macOS extraction omits the native uninstaller flags/CRC.');
const builder = path.resolve(options['--builder']);
if (JSON.parse(fs.readFileSync(path.join(path.dirname(builder), 'package.json'), 'utf8')).version !== '25.1.8') throw Error('Pinned electron-builder 25.1.8 is required');
const root = path.resolve(options['--output-dir']);
if (fs.existsSync(root)) throw Error('Refusing to reuse an existing QA output directory');
const client = path.resolve(__dirname, '../..');
const nsis = options['--nsis-root'] || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1')
  : path.join(os.homedir(), 'Library/Caches/electron-builder/nsis/nsis-3.0.4.1'));
const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : 'mac/makensis');
const previous = options['--identity-file'] ? JSON.parse(fs.readFileSync(options['--identity-file'], 'utf8')) : null;
if (previous && (previous.kind !== 'Synthetic Nuwax installer recovery QA' || !previous.syntheticPayload || !/^[0-9a-f-]{36}$/.test(previous.guid))) throw Error('Unexpected QA identity source');
const guid = previous?.guid || crypto.randomUUID();
const identity = 'NuwaxRecoveryQA' + guid.slice(0, 8);
const name = 'nuwax-recovery-qa-' + guid.slice(0, 8);
const version = options['--version'] || '3.0.20-qa.recovery.1';
if (!/^3\.0\.\d+-qa\.recovery\.\d+$/.test(version)) throw Error('An isolated recovery QA version is required');
const source = path.join(root, 'build'), app = path.join(root, 'app');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
for (const file of fs.readdirSync(path.join(client, 'nuwa-electron-shell/crates/agent-electron-client/build'))) {
  if (!/\.(nsh|ps1)$/.test(file)) continue;
  let data = fs.readFileSync(path.join(client, 'nuwa-electron-shell/crates/agent-electron-client/build', file), 'utf8');
  if (file === 'normalize-old-install.ps1') {
    for (const [from, to] of [["$uninstallerName = 'Uninstall Nuwax.exe'", `$uninstallerName = 'Uninstall ${identity}.exe'`], ["  'Nuwax.exe',", `  '${identity}.exe',`]]) {
      if (data.split(from).length !== 2) throw Error('Unexpected normalizer identity');
      data = data.replace(from, to);
    }
  }
  if (file === 'repair-shortcuts.ps1') data = data.replaceAll("'Nuwax.exe'", `'${identity}.exe'`);
  fs.writeFileSync(path.join(source, file), data);
}
const compilerEnv = { ...process.env, NSISDIR: nsis };
for (const [file, exitCode] of [[path.join(app, identity + '.exe'), 0], [path.join(root, 'legacy-exit-2.exe'), 2]]) {
  const script = path.join(root, 'payload-' + exitCode + '.nsi');
  fs.writeFileSync(script, `Unicode true\nName "Synthetic recovery fixture"\nOutFile "${file}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nSetErrorLevel ${exitCode}\nSectionEnd\n`);
  execFileSync(compiler, ['-V2', script], { env: compilerEnv, stdio: 'inherit' });
}
fs.writeFileSync(path.join(app, 'resources/app.asar'), 'Synthetic archive: no Electron application is launched.');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version, author: 'Nuwax', description: 'Isolated Windows recovery acceptance', main: 'index.js' }));
const inventory = require('../../nuwa-electron-shell/crates/agent-electron-client/scripts/build/uninstall-payload.cjs').writeUninstallPayload({
  appOutDir: app, arch: 1, packager: { projectDir: root, appInfo: { name, productFilename: identity } },
});
fs.writeFileSync(path.join(source, 'qa-include.nsh'), `!define NUWAX_UNINSTALL_MANIFEST "${inventory}"\n!include "${path.join(source, 'installer.nsh')}"\n`);
const config = {
  extends: null, appId: 'com.nuwax-ai.recoveryqa.' + guid, productName: identity, executableName: identity,
  electronVersion: '40.8.2', npmRebuild: false, compression: 'store',
  directories: { output: path.join(root, 'installers'), buildResources: source },
  win: { target: ['nsis'], signAndEditExecutable: false },
  nsis: { guid, include: path.join(source, 'qa-include.nsh'), oneClick: false, perMachine: false,
    allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, runAfterFinish: false,
    shortcutName: identity, artifactName: 'RecoveryQA-Setup.exe', warningsAsErrors: false },
  publish: null,
};
fs.writeFileSync(path.join(root, 'builder.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, [builder, '--win', 'nsis', '--x64', '--prepackaged', app,
  '--config', path.join(root, 'builder.json'), '--publish', 'never'], {
  cwd: root, stdio: 'inherit', env: { ...compilerEnv, CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '', WIN_CSC_LINK: '', SKIP_WINDOWS_AFTER_SIGN: '1' },
});
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(path.join(root, 'qa-meta.json'), JSON.stringify({ kind: 'Synthetic Nuwax installer recovery QA', guid, identity, name, version,
  installerSha256: digest(path.join(root, 'installers/RecoveryQA-Setup.exe')),
  executableSha256: digest(path.join(app, identity + '.exe')),
  source: Object.fromEntries(fs.readdirSync(source).map(file => [file, digest(path.join(source, file))])),
  signed: false, nativeWindows: true, syntheticPayload: true }, null, 2));
console.log('QA_BUILD_READY', root);
