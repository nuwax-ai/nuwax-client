#!/usr/bin/env node
// Real Electron IPC fixture. The OS launcher is stubbed so unsafe test URIs never run.
const fs = require('node:fs'), path = require('node:path');
const base = path.resolve(__dirname, '../../nuwa-electron-shell/crates/agent-electron-client');
const out = path.resolve(process.argv[2] || '.cache/open-external-20261018');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qaExternal',{open:value=>ipcRenderer.invoke('shell:openExternal',value)});`);
const source = `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http');
const {createExternalOpenHandler}=require(${JSON.stringify(path.join(base,'src/main/ipc/openExternal.ts'))});
const out=__dirname,rows=[],calls=[],windows=[];let server;
app.setName('NuwaxOpenExternalQA');app.setPath('userData',path.join(out,'user-data'));app.setAppLogsPath(path.join(out,'logs'));app.commandLine.appendSwitch('disable-gpu');
function window(){const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(out,'preload.cjs')}});windows.push(w);return w;}
async function invoke(win,value){return win.webContents.executeJavaScript('window.qaExternal.open('+JSON.stringify(value)+')');}
app.whenReady().then(async()=>{
 const file=path.join(out,'host.html');fs.writeFileSync(file,'<title>Nuwax external link QA</title><h1>Generated IPC fixture</h1>');const entry=require('node:url').pathToFileURL(file).href;
 const host=window();ipcMain.handle('shell:openExternal',createExternalOpenHandler(()=>host.webContents,entry,async url=>{calls.push(url)}));await host.loadFile(file);
 assert.equal((await invoke(host,'HTTPS://EXAMPLE.COM/docs#source')).success,true);assert.deepEqual(calls,['https://example.com/docs#source']);rows.push({case:'host-web-link-reaches-dispatcher',passed:true});
 for(const uri of ['file:///C:/run.exe','ms-msdt:/test','javascript:void(0)','data:text/html,test','powershell:run','https:\\\\example.com',null,{}])assert.equal((await invoke(host,uri)).success,false);
 assert.equal(calls.length,1);rows.push({case:'unsafe-protocols-never-dispatched',passed:true});
 const foreign=window();await foreign.loadFile(file);assert.equal((await invoke(foreign,'https://example.com/')).success,false);assert.equal(calls.length,1);rows.push({case:'foreign-window-rejected',passed:true});
 const other=path.join(out,'other.html');fs.writeFileSync(other,'<h1>Other local document</h1>');await host.loadFile(other);assert.equal((await invoke(host,'https://example.com/')).success,false);rows.push({case:'other-local-host-document-rejected',passed:true});
 server=http.createServer((req,res)=>res.end('<h1>Synthetic remote document</h1>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));await host.loadURL('http://127.0.0.1:'+server.address().port+'/');
 assert.equal((await invoke(host,'https://example.com/')).success,false);assert.equal(calls.length,1);rows.push({case:'navigated-http-host-rejected',passed:true});
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,platform:process.platform,electron:process.versions.electron,arch:process.arch,cases:rows,osLaunchStubbed:true,unsafeUrisExecuted:false,scope:'Canonical handler and current-frame authorization through real Electron IPC, synthetic documents'},null,2));
 windows.forEach(w=>w.destroy());server.close();app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),String(error.stack||error));windows.forEach(w=>w.destroy());server?.close();app.exit(1);});
`;
require(path.join(base,'node_modules/esbuild')).build({stdin:{contents:source,resolveDir:base},outfile:path.join(out,'main.cjs'),bundle:true,platform:'node',external:['electron'],tsconfig:path.join(base,'tsconfig.main.json')}).catch(error=>{console.error(error);process.exitCode=1;});
