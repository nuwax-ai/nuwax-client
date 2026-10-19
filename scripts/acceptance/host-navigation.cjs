#!/usr/bin/env node
// Builds a self-contained Electron fixture; it only serves synthetic loopback pages.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
const output = path.resolve(process.argv[2] || '.cache/host-navigation-20261018');
fs.mkdirSync(output, { recursive: true });
const source = `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {guardHostNavigation}=require(${JSON.stringify(path.join(base,'src/main/services/system/hostNavigation.ts'))});
const out=__dirname;const rows=[];const windows=[];
app.setName('NuwaxHostNavigationQA');app.setPath('userData',path.join(out,'user-data'));app.setAppLogsPath(path.join(out,'logs'));
app.commandLine.appendSwitch('disable-gpu');
const server=http.createServer((req,res)=>{
 if(req.url==='/redirect'){res.writeHead(302,{Location:'http://localhost:'+server.address().port+'/outside'});res.end();return;}
 res.end('<h1>Local synthetic business page</h1>');
});
function eventOnce(contents,name){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Missing '+name)),10000);contents.once(name,(event)=>{clearTimeout(timeout);resolve(event);});});}
async function attempt(win,url){
 const observed=eventOnce(win.webContents,'will-frame-navigate');
 await win.webContents.executeJavaScript('location.href='+JSON.stringify(url));
 const event=await observed;assert.equal(event.isMainFrame,true);assert.equal(event.defaultPrevented,true);
}
app.whenReady().then(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const file=path.join(out,'host.html');fs.writeFileSync(file,'<title>Nuwax navigation QA</title><h1>Host renderer fixture</h1><p>Only generated loopback pages are tested.</p>');
 const entry=require('node:url').pathToFileURL(file).href;
 const win=new BrowserWindow({show:true,width:900,height:600,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});windows.push(win);
 guardHostNavigation(win.webContents,entry);await win.loadFile(file);
 await win.webContents.executeJavaScript('location.hash="settings"');assert.equal(win.webContents.getURL(),entry+'#settings');rows.push({case:'local-renderer-hash',passed:true});
 await attempt(win,origin+'/outside');assert.equal(win.webContents.getURL(),entry+'#settings');rows.push({case:'host-http-navigation-blocked',passed:true});
 const other=path.join(out,'other.html');fs.writeFileSync(other,'<h1>Other local document</h1>');
 await attempt(win,require('node:url').pathToFileURL(other).href);assert.equal(win.webContents.getURL(),entry+'#settings');rows.push({case:'other-local-document-blocked',passed:true});
 const dev=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});windows.push(dev);
 guardHostNavigation(dev.webContents,origin+'/');await dev.loadURL(origin+'/');
 const loaded=eventOnce(dev.webContents,'did-finish-load');await dev.webContents.executeJavaScript('location.href="/settings"');await loaded;
 assert.equal(dev.webContents.getURL(),origin+'/settings');rows.push({case:'same-dev-origin-navigation',passed:true});
 const redirected=eventOnce(dev.webContents,'will-redirect');await dev.loadURL(origin+'/redirect').catch(()=>{});const event=await redirected;
 assert.equal(event.defaultPrevented,true);assert.notEqual(new URL(dev.webContents.getURL()).hostname,'localhost');rows.push({case:'cross-origin-server-redirect-blocked',passed:true});
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,electron:process.versions.electron,platform:process.platform,arch:process.arch,cases:rows,scope:'Canonical host guard in real Electron, synthetic pages, no account or installed app used'},null,2));
 windows.forEach(w=>w.destroy());server.close();app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),String(error.stack||error));windows.forEach(w=>w.destroy());server.close();app.exit(1);});
`;
require(path.join(base,'node_modules/esbuild')).build({stdin:{contents:source,resolveDir:base},outfile:path.join(output,'main.cjs'),bundle:true,platform:'node',external:['electron'],tsconfig:path.join(base,'tsconfig.main.json')}).catch(error=>{console.error(error);process.exitCode=1;});
