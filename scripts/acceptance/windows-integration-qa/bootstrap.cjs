// QA-only entry: production bundles below are unchanged. Confine all runtime
// data before importing them, including an Explorer restart after NSIS update.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = 'C:\\nuwax-qa\\integration-20261018';
if (JSON.parse(fs.readFileSync(path.join(root, 'owner.json'), 'utf8').replace(/^\uFEFF/, '')).kind !== 'Owned integrated Windows QA') throw Error('Missing QA owner');
const profile = path.join(root, 'profile');
process.env.USERPROFILE = profile;
process.env.APPDATA = path.join(profile, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(profile, 'AppData', 'Local');
const { app, BrowserWindow, shell } = require('electron');
app.setPath('home', profile); app.setPath('appData', process.env.APPDATA); app.setPath('userData', path.join(process.env.APPDATA, 'Nuwax'));
const setModel = app.setAppUserModelId.bind(app);
app.setAppUserModelId = () => setModel('com.nuwax-ai.nuwax.integrationqa.20261018');
app.commandLine.appendSwitch('disable-gpu');
const version = app.getVersion();
const write = (name, value) => fs.writeFileSync(path.join(root, name + '-' + version + '.json'), JSON.stringify(value, null, 2));
process.on('uncaughtException', error => write('runtime-error', { error: String(error.stack || error).slice(0, 6000) }));
const launches = [], openExternal = shell.openExternal.bind(shell);
shell.openExternal = async (url, ...args) => {
  // Intercept only synthetic probes, so even a regression cannot launch an
  // unsafe OS protocol. Normal UI links retain the production dispatcher.
  if (url.includes('nuwax-integration-qa') || /^(file|powershell|javascript|ms-msdt):/i.test(url)) { launches.push(url); return; }
  return openExternal(url, ...args);
};
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('page-title-updated', event => { event.preventDefault(); win.setTitle('Nuwax Integration QA ' + version); });
});
require('./dist/main/main.js');
let handled = '', busy = false;
const host = () => BrowserWindow.getAllWindows().find(w => /\/dist\/(?:renderer\/)?index\.html/.test(w.webContents.getURL().replaceAll('\\', '/')));
async function security(win) {
  const rows = [], call = js => win.webContents.executeJavaScript(js);
  assert.equal(await call('window.electronAPI.app.getVersion()'), version);
  rows.push({ case: 'installed-production-main-preload-renderer', passed: true });
  const good = 'https://example.invalid/nuwax-integration-qa';
  assert.equal((await call('window.electronAPI.shell.openExternal(' + JSON.stringify(good) + ')')).success, true);
  assert.deepEqual(launches, [good]);
  for (const value of ['file:///nuwax-integration-qa.exe', 'powershell:nuwax-integration-qa', 'javascript:nuwax-integration-qa']) assert.equal((await call('window.electronAPI.shell.openExternal(' + JSON.stringify(value) + ')')).success, false);
  assert.deepEqual(launches, [good]); rows.push({ case: 'actual-external-handler-safe-protocols', passed: true });
  assert.equal((await call('window.electronAPI.agentRunner.start({binPath:"nuwax-integration-qa-never-run.exe",apiKey:"synthetic-test-only"})')).success, false);
  rows.push({ case: 'actual-preload-legacy-runner-rejected', passed: true });
  const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'qa-foreign-preload.cjs') } });
  try {
    await foreign.loadURL('data:text/html,<h1>Synthetic QA sender</h1>');
    const invoke = (channel, value) => foreign.webContents.executeJavaScript('window.qaForeign.invoke(' + JSON.stringify(channel) + ',' + JSON.stringify(value) + ')');
    assert.equal((await invoke('shell:openExternal', good)).success, false);
    assert.equal((await invoke('agentRunner:start', { binPath: 'nuwax-integration-qa-never-run.exe', apiKey: 'synthetic-test-only' })).success, false);
    assert.deepEqual(launches, [good]); rows.push({ case: 'actual-ipc-foreign-source-and-old-runner-denied', passed: true });
  } finally { foreign.destroy(); }
  const original = win.webContents.getURL();
  fs.writeFileSync(path.join(root, 'other.html'), '<h1>Own generated local document</h1>');
  for (const url of ['http://127.0.0.1:55321/probe', require('node:url').pathToFileURL(path.join(root, 'other.html')).href]) {
    const observed = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('No navigation event')), 5000); win.webContents.once('will-frame-navigate', event => { clearTimeout(timer); resolve(event.defaultPrevented); }); });
    await call('location.href=' + JSON.stringify(url)); assert.equal(await observed, true); assert.equal(win.webContents.getURL(), original);
  }
  rows.push({ case: 'actual-privileged-host-navigation-blocked', passed: true });
  return { passed: true, version, pid: process.pid, electron: process.versions.electron, cases: rows, syntheticOsDispatchIntercepted: true, appPath: app.getAppPath(), userData: app.getPath('userData'), home: app.getPath('home') };
}
const timer = setInterval(async () => {
  if (busy) return;
  const win = host(); if (!win) return;
  write('runtime-ready', { pid: process.pid, version, url: win.webContents.getURL(), home: app.getPath('home'), userData: app.getPath('userData') });
  const file = path.join(root, 'command.json'); if (!fs.existsSync(file)) return;
  const command = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (command.id === handled) return; handled = command.id; busy = true;
  try {
    if (command.action === 'security') write('security-result', await security(win));
    else if (command.action === 'quit') { clearInterval(timer); app.quit(); }
  } catch (error) { write('security-result', { passed: false, error: String(error.stack || error) }); }
  finally { busy = false; }
}, 1000);
