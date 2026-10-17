#!/usr/bin/env node
// Isolated Electron check of the shipped preload and legacy IPC rejection.
const fs = require('node:fs'), path = require('node:path');
const base = path.resolve(__dirname, '../../nuwa-electron-shell/crates/agent-electron-client');
const out = path.resolve(process.argv[2] || '.cache/agent-runner-20261018');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'legacy-preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('legacyRunner',{start:value=>ipcRenderer.invoke('agentRunner:start',value)});`);
const source = `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {legacyAgentRunnerUnavailable}=require(${JSON.stringify(path.join(base, 'src/shared/legacyAgentRunner.ts'))});
const rows=[],windows=[];let requests=0;
app.setName('NuwaxRunnerBoundaryQA');app.setPath('userData',path.join(__dirname,'user-data'));app.setAppLogsPath(path.join(__dirname,'logs'));app.commandLine.appendSwitch('disable-gpu');
function window(preload){const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(__dirname,preload)}});windows.push(w);return w;}
app.whenReady().then(async()=>{
 const file=path.join(__dirname,'fixture.html');fs.writeFileSync(file,'<title>Nuwax runner QA</title><h1>Synthetic legacy runner check</h1>');
 ipcMain.handle('agentRunner:start',(...args)=>{requests++;return legacyAgentRunnerUnavailable(...args)});
 const current=window('preload.cjs');await current.loadFile(file);
 const result=await current.webContents.executeJavaScript('window.electronAPI.agentRunner.start({binPath:"C:/synthetic/never-run.exe",apiKey:crypto.randomUUID(),backendPort:1,proxyPort:2,apiBaseUrl:"http://127.0.0.1:1",defaultModel:"synthetic"})');
 assert.deepEqual(result,legacyAgentRunnerUnavailable());assert.equal(requests,0);
 rows.push({case:'canonical-preload-rejects-without-config-ipc',passed:true});
 const legacy=window('legacy-preload.cjs');await legacy.loadFile(file);
 const oldResult=await legacy.webContents.executeJavaScript('window.legacyRunner.start({binPath:"C:/synthetic/never-run.exe",apiKey:crypto.randomUUID()})');
 assert.deepEqual(oldResult,legacyAgentRunnerUnavailable());assert.equal(requests,1);assert.deepEqual(Object.keys(oldResult).sort(),['error','success']);
 rows.push({case:'legacy-ipc-rejected-without-config-echo',passed:true});
 fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:true,platform:process.platform,electron:process.versions.electron,arch:process.arch,cases:rows,scope:'Canonical production preload plus shared rejection callback through real Electron IPC; actual registerProcessHandlers wiring separately covered by unit tests',realCredentialsUsed:false,externalBinaryStarted:false},null,2));
 windows.forEach(w=>w.destroy());app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(__dirname,'error.txt'),String(error.stack||error));windows.forEach(w=>w.destroy());app.exit(1)});
`;
const esbuild = require(path.join(base, 'node_modules/esbuild'));
Promise.all([
  esbuild.build({ entryPoints: [path.join(base, 'src/preload/index.ts')], outfile: path.join(out, 'preload.cjs'), bundle: true, platform: 'node', external: ['electron'], tsconfig: path.join(base, 'tsconfig.main.json') }),
  esbuild.build({ stdin: { contents: source, resolveDir: base }, outfile: path.join(out, 'main.cjs'), bundle: true, platform: 'node', external: ['electron'], tsconfig: path.join(base, 'tsconfig.main.json') }),
]).catch(error => { console.error(error); process.exitCode = 1; });
