#!/usr/bin/env node
/** Real Electron IPC/renderer fixture; controls only its own synthetic task. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '../../nuwa-electron-shell/crates/agent-electron-client');
const out = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-cua-controls-'));
fs.mkdirSync(out, { recursive: true });
const esbuild = require(path.join(base, 'node_modules/esbuild'));
(async () => {
  await esbuild.build({ entryPoints: [path.join(base, 'src/preload/cuaControls.ts')], outfile: path.join(out, 'preload.cjs'), bundle: true, platform: 'node', external: ['electron'] });
  const runner = `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createCuaControlWindow}=require(${JSON.stringify(path.join(base, 'src/main/services/cua/controlWindow.ts'))});
const labels=require(${JSON.stringify(path.join(base, 'src/shared/locales/zh-CN.json'))});
const out=${JSON.stringify(out)};let dispose;
app.whenReady().then(async()=>{
 let listener,authenticated=true;const actions=[];
 let state={revision:1,phase:'running',taskId:'synthetic',startedAt:Date.now(),updatedAt:Date.now(),steps:[{sequence:1,tool:'get_window_state',startedAt:Date.now(),outcome:'ok'}],stepCount:1,reason:null,needsObservation:false,resultObserved:true,scope:{kind:'window',pid:1,windowId:1,label:'测试窗口 <script>invalid()</script>'}};
 dispose=createCuaControlWindow({getRuntime:()=>state,subscribe:(fn)=>{listener=fn;return()=>{listener=null}},authenticated:()=>authenticated,t:(key)=>labels[key]||key,preloadPath:path.join(out,'preload.cjs'),action:async(action)=>{actions.push(action);state={...state,revision:state.revision+1,phase:action==='pause'?'paused':action==='resume'?'running':'stopped',reason:action==='pause'?'userPaused':null};listener(state);return {success:true}}});
 const owned=BrowserWindow.getAllWindows()[0];
 if(owned.webContents.isLoading())await new Promise(r=>owned.webContents.once('did-finish-load',r));
 const evaluate=(js)=>owned.webContents.executeJavaScript(js);
 assert.equal((await evaluate('window.cuaControls.getRuntime()')).phase,'running');
 assert.equal(await evaluate('typeof window.require'),'undefined');
 assert.equal(await evaluate('document.querySelectorAll("#scope script").length'),0);
 await evaluate('window.cuaControls.action("pause")');assert.equal(state.phase,'paused');
 authenticated=false;assert.equal((await evaluate('window.cuaControls.action("resume")')).success,false);authenticated=true;
 assert.equal((await evaluate('window.cuaControls.action("unknown")')).success,false);
 assert.equal(await evaluate('document.querySelector("#resume").hidden'),false);
 await evaluate('window.cuaControls.action("resume")');assert.equal(state.phase,'running');
 const foreign=new BrowserWindow({show:false,webPreferences:{preload:path.join(out,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await foreign.loadURL('data:text/html,foreign');
 assert.equal(await foreign.webContents.executeJavaScript('window.cuaControls.getRuntime()'),null);
 assert.equal((await foreign.webContents.executeJavaScript('window.cuaControls.action("stop")')).success,false);
 foreign.destroy();
 fs.writeFileSync(path.join(out,'floating-controls.png'),(await owned.webContents.capturePage()).toPNG());
 owned.close();assert.equal(state.phase,'stopped');assert.deepEqual(actions,['pause','resume','stop']);
 dispose();dispose=null;assert.equal(listener,null);assert.equal(BrowserWindow.getAllWindows().length,0);
 console.log('PASS: floating window, real preload/IPC, authenticated resume, foreign sender rejection, safe rendering, close-to-stop, cleanup.');app.exit(0);
}).catch(error=>{console.error(error);dispose?.();app.exit(1)});
`;
  await esbuild.build({ stdin: { contents: runner, resolveDir: base }, outfile: path.join(out, 'main.cjs'), bundle: true, platform: 'node', external: ['electron'], tsconfig: path.join(base, 'tsconfig.main.json') });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require(path.join(base, 'node_modules/electron')), [path.join(out, 'main.cjs')], { env, encoding: 'utf8', timeout: 30000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  console.log('Evidence directory:', out);
})().catch((error) => { console.error(error); process.exitCode = 1; });
