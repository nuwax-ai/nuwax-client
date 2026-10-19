// Build real integrated app archives and NSIS packages using the verified
// Windows dependency payload. Main/preload/renderer come from this worktree.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const root = 'C:/nuwax-qa/integration-20261018', source = root + '/source', payload = root + '/payload', stage = root + '/app-stage', project = root + '/project';
const identity = 'NuwaxIntegrationQA', name = 'nuwax-integration-qa';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
if (process.platform !== 'win32' || readJson(root + '/owner.json').kind !== 'Owned integrated Windows QA') throw Error('Wrong QA environment');
const toolchain = 'C:/nuwax-qa/u1-20261018/toolchain/node_modules';
const asar = require(toolchain + '/@electron/asar');
const { finished } = require('node:stream/promises');
(async () => {
  if (process.argv[2] === 'prepare') {
    if ([payload, stage, project].some(fs.existsSync)) throw Error('Refuse existing build staging');
    fs.mkdirSync(project);
    fs.cpSync('C:/nuwax-qa/u1-20261018-offload/payload', payload, { recursive: true });
    fs.renameSync(payload + '/NuwaxU1QA.exe', payload + '/' + identity + '.exe');
    asar.extractAll(payload + '/resources/app.asar', stage);
    fs.rmSync(stage + '/dist', { recursive: true, force: true });
    fs.cpSync(source + '/dist', stage + '/dist', { recursive: true });
    fs.copyFileSync(source + '/bootstrap.cjs', stage + '/qa-bootstrap.cjs');
    fs.copyFileSync(source + '/foreign-preload.cjs', stage + '/qa-foreign-preload.cjs');
    let normalizer = fs.readFileSync(source + '/normalize-old-install.ps1', 'utf8');
    for (const [from, to] of [["$uninstallerName = 'Uninstall Nuwax.exe'", `$uninstallerName = 'Uninstall ${identity}.exe'`], ["  'Nuwax.exe',", `  '${identity}.exe',`]]) {
      if (normalizer.split(from).length !== 2) throw Error('Unexpected normalizer identity');
      normalizer = normalizer.replace(from, to);
    }
    fs.writeFileSync(source + '/normalize-old-install.ps1', normalizer);
    console.log('Integrated Windows app staging prepared');
    return;
  }
  const number = process.argv[2];
  if (!['1', '2'].includes(number)) throw Error('Expected prepare, 1 or 2');
  const version = '3.0.17-qa.integration.' + number;
  fs.copyFileSync(source + '/bootstrap.cjs', stage + '/qa-bootstrap.cjs');
  fs.copyFileSync(source + '/foreign-preload.cjs', stage + '/qa-foreign-preload.cjs');
  const pkg = readJson(stage + '/package.json');
  Object.assign(pkg, { name, version, main: 'qa-bootstrap.cjs' });
  fs.writeFileSync(stage + '/package.json', JSON.stringify(pkg, null, 2));
  fs.rmSync(payload + '/resources/app.asar.unpacked', { recursive: true, force: true });
  const archive = payload + '/resources/app.asar';
  // This pinned ASAR API resolves to its writable stream before the final
  // writes finish. Synchronous packaging would otherwise freeze that stream
  // and put an empty archive in the installer.
  const archiveStream = await asar.createPackageWithOptions(stage, archive, { unpackDir: 'node_modules', unpack: '**/*.node' });
  await finished(archiveStream);
  asar.uncacheAll();
  if (!fs.statSync(archive).size || JSON.parse(asar.extractFile(archive, 'package.json')).version !== version) throw Error('Incomplete QA archive');
  const main = path.join('dist', 'main', 'main.js');
  if (!asar.extractFile(archive, main).equals(fs.readFileSync(stage + '/dist/main/main.js'))) throw Error('Wrong QA main bundle');
  fs.writeFileSync(payload + '/resources/app-update.yml', 'provider: generic\nurl: http://127.0.0.1:55321\nupdaterCacheDirName: ' + name + '-updater\n');
  fs.writeFileSync(project + '/package.json', JSON.stringify({ name, version, description: 'Isolated integrated Windows acceptance', author: 'Nuwax', main: 'none.js' }));
  const inventory = require(source + '/uninstall-payload.cjs').writeUninstallPayload({ appOutDir: payload, arch: 1, packager: { projectDir: project, appInfo: { name, productFilename: identity } } });
  fs.copyFileSync(inventory, root + '/payload-' + number + '.json');
  const config = {
    extends: null, appId: 'com.nuwax-ai.nuwax.integrationqa.20261018', productName: identity, executableName: identity,
    // QA validates installer behavior, not download size. Avoid spending the
    // acceptance cycle compressing x64 payloads under ARM emulation.
    electronVersion: '40.8.2', npmRebuild: false, compression: 'normal',
    directories: { output: root + '/installers', buildResources: source },
    win: { target: ['nsis'], signAndEditExecutable: false },
    nsis: { include: source + '/installer.nsh', oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, runAfterFinish: false, shortcutName: identity, artifactName: identity + '-\${version}.exe', warningsAsErrors: false },
    publish: null,
  };
  fs.writeFileSync(project + '/builder.json', JSON.stringify(config, null, 2));
  execFileSync(process.execPath, [toolchain + '/electron-builder/cli.js', '--win', 'nsis', '--x64', '--prepackaged', payload, '--config', project + '/builder.json', '--publish', 'never'], { cwd: project, stdio: 'inherit', env: { ...process.env, ELECTRON_BUILDER_COMPRESSION_LEVEL: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '', WIN_CSC_LINK: '', SKIP_WINDOWS_AFTER_SIGN: '1' } });
  console.log('INTEGRATED_QA_BUILT', version);
})().catch(error => { console.error(error); process.exitCode = 1; });
