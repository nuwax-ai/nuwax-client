#!/usr/bin/env node
// Run only inside the owned UTM QA directory. Existing production/QA installs
// are read-only sources; installers use a separate app identity and directory.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform !== 'win32') throw Error('Windows QA runtime required');
const root = 'C:/nuwax-qa/upgrade-restore-20261018';
const source = `${root}/source`, payload = `${root}/payload`, project = `${root}/project`;
const identity = 'NuwaxRestoreQA';
if (JSON.parse(fs.readFileSync(`${root}/owner.json`, 'utf8').replace(/^\uFEFF/, '')).kind !== 'Owned upgrade nested-restore QA') throw Error('Wrong QA owner');
if (process.argv[2] === 'prepare') {
  if (fs.existsSync(payload) || fs.existsSync(project)) throw Error('Refuse existing QA build directories');
  fs.mkdirSync(project);
  fs.cpSync('C:/nuwax-qa/u1-20261018-offload/payload', payload, { recursive: true });
  fs.renameSync(`${payload}/NuwaxU1QA.exe`, `${payload}/${identity}.exe`);
  for (const variant of ['baseline', 'fixed']) {
    const dir = `${source}/${variant}`;
    fs.mkdirSync(dir);
    fs.copyFileSync(`${source}/installer.nsh`, `${dir}/installer.nsh`);
    let text = fs.readFileSync(`${source}/normalize-${variant}.ps1`, 'utf8');
    for (const [from, to] of [["$uninstallerName = 'Uninstall Nuwax.exe'", `$uninstallerName = 'Uninstall ${identity}.exe'`], ["  'Nuwax.exe',", `  '${identity}.exe',`]]) {
      if (text.split(from).length !== 2) throw Error('Unexpected normalizer identity');
      text = text.replace(from, to);
    }
    fs.writeFileSync(`${dir}/normalize-old-install.ps1`, text);
  }
  console.log('QA payload and identity prepared');
} else {
  const variant = process.argv[2];
  if (!['baseline', 'fixed'].includes(variant)) throw Error('Expected prepare, baseline or fixed');
  const version = variant === 'baseline' ? '3.0.17-qa.restore.1' : '3.0.17-qa.restore.2';
  fs.writeFileSync(`${project}/package.json`, JSON.stringify({ name: 'nuwax-restore-qa', version, description: 'Isolated upgrade restoration acceptance', author: 'Nuwax', main: 'none.js' }));
  const config = {
    appId: 'com.nuwax-ai.nuwax.restoreqa.20261018', productName: identity, executableName: identity,
    electronVersion: '40.8.2', npmRebuild: false, compression: 'normal',
    directories: { output: `${root}/installers`, buildResources: `${source}/${variant}` },
    win: { target: ['nsis'], signAndEditExecutable: false },
    nsis: { include: `${source}/${variant}/installer.nsh`, oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, runAfterFinish: false, shortcutName: identity, artifactName: `${identity}-\${version}.exe`, warningsAsErrors: false },
    publish: null,
  };
  const configPath = `${project}/builder-${variant}.json`;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  execFileSync(process.execPath, ['C:/nuwax-qa/u1-20261018/toolchain/node_modules/electron-builder/cli.js', '--win', 'nsis', '--x64', '--prepackaged', payload, '--config', configPath, '--publish', 'never'], {
    cwd: project, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '', WIN_CSC_LINK: '', SKIP_WINDOWS_AFTER_SIGN: '1' },
  });
  console.log('QA installer built:', path.join(root, 'installers', `${identity}-${version}.exe`));
}
