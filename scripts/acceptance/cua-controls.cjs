#!/usr/bin/env node
/** UI-only Electron fixture. --build-only lets the authorized debug device execute it. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '../../nuwa-electron-shell/crates/agent-electron-client');
const source = path.resolve(__dirname, '../../nuwa-electron-shell/crates/agent-electron-client');
const out = path.resolve(process.argv[2] || '.cache/cua-ui-fixture');
fs.mkdirSync(out, { recursive: true });
const esbuild = require(path.join(base, 'node_modules/esbuild'));
(async () => {
  await esbuild.build({ entryPoints: [path.join(source, 'src/preload/features/computer-use/controlPreload.ts')], outfile: path.join(out, 'preload.cjs'), bundle: true, platform: 'node', external: ['electron'] });
  const runner = `
const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createCuaControlWindow}=require(${JSON.stringify(path.join(source, 'src/main/features/computer-use/controlWindow.ts'))});
const labels=require(${JSON.stringify(path.join(source, 'src/shared/locales/zh-CN.json'))});
const out=__dirname,wait=ms=>new Promise(r=>setTimeout(r,ms));
app.setName('Computer Use UI Regression');app.setPath('userData',path.join(out,'isolated-user-data'));
app.on('window-all-closed',()=>{});let dispose;
app.whenReady().then(async()=>{
 nativeTheme.themeSource='light';
 const main=new BrowserWindow({width:1100,height:760,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await main.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html lang="zh"><meta charset="utf-8"><style>body{margin:0;background:#f5f6f8;color:#20242c;font:16px system-ui}header{height:40px;padding:12px 24px;background:#fff;border-bottom:1px solid #ddd}main{padding:100px 40px}h1{font-size:28px}p{color:#67717e;line-height:2}</style><header>Computer Use · 界面回归（独立测试数据）</header><main><h1>窗口内预览与操作控制</h1><p>只操作本测试创建的两个任务。<br>任务列表含进行中和已暂停窗口，历史不在预览中显示。<br>关闭预览不会停止任务，可由明确查看动作重新打开。</p></main></html>'));
 const task=(id,phase)=>({taskId:id,bindingId:id,epoch:1,phase,revision:1,startedAt:Date.now(),updatedAt:Date.now(),steps:[],stepCount:0,reason:null,stats:{steps:0,refused:0,uncertain:0,pauses:0,resumes:0,violations:0},mode:'background',color:id==='A'?'#4f8cff':'#ba68e8',scope:{kind:'window',pid:100,windowId:id==='A'?1:2,label:'验收编辑器 '+id}});
 let state={...task('A','running'),multiwindow:true,tasks:[task('A','running'),task('B','paused'),task('C','completed')]};
 let notify,preference=null;const actions=[];let captures=0;
 dispose=createCuaControlWindow({getMainWindow:()=>main,getRuntime:()=>state,subscribe:fn=>{notify=fn;return()=>{notify=null}},authenticated:()=>true,t:key=>labels[key]||key,preloadPath:path.join(out,'preload.cjs'),
 readPreference:()=>preference,writePreference:value=>{preference=value},
 previewIdentity:id=>({taskId:id,bindingId:id,epoch:1}),capturePreview:async id=>{captures++;return {taskId:id,status:'unavailable'}},
 taskAction:async(id,action)=>{actions.push({id,action});return {success:true}}});
 const view=()=>main.contentView.children[0],wc=()=>view().webContents;
 const until=async test=>{for(let n=0;n<100;n++){if(await test())return;await wait(30)}throw Error('UI condition timeout')};
 await until(()=>wc()&&!wc().isLoading()&&wc().getURL().startsWith('data:'));await wait(120);
 const evalUi=js=>wc().executeJavaScript(js);
 dispose.showTask('A');await wait(100);
 const initial=view().getBounds();assert.equal(initial.width,248);assert.equal(initial.height,160);assert.equal(initial.y,72);
 assert.equal(initial.x,Math.max(0,main.getContentBounds().width-272));
 assert.deepEqual((await evalUi('window.cuaControls.getRuntime()')).tasks.map(t=>t.taskId),['A','B']);
 assert.equal(dispose.showTask('C').success,false);
 assert.equal(await evalUi('document.querySelector("#viewport").disabled'),false);
 assert.equal(await evalUi('document.querySelector("#stop").disabled'),false);
 fs.writeFileSync(path.join(out,'preview-top-right.png'),(await wc().capturePage()).toPNG());
 await evalUi('document.querySelector("#stack button").click()');await wait(100);
 assert.deepEqual((await evalUi('window.cuaControls.getRuntime()')).tasks.map(t=>t.taskId),['B','A']);
 assert.equal((await evalUi('window.cuaControls.getPresentation()')).taskId,'B');
 await evalUi('document.querySelector("#stop").click()');await wait(40);
 assert.deepEqual(actions,[{id:'B',action:'takeover'},{id:'B',action:'stop'}]);
 const foreign=new BrowserWindow({show:false,webPreferences:{preload:path.join(out,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await foreign.loadURL('data:text/html,foreign');
 assert.equal(await foreign.webContents.executeJavaScript('window.cuaControls.close()'),false);
 assert.equal(await foreign.webContents.executeJavaScript('window.cuaControls.move({x:0,y:0})'),null);foreign.destroy();
 assert.equal(await evalUi('window.cuaControls.move({x:NaN,y:0})'),null);
 await evalUi('window.cuaControls.move({x:80,y:180})');await wait(250);
 assert.equal(view().getBounds().x,80);assert.equal(view().getBounds().y,180);assert.equal(preference.position.x,80);
 fs.writeFileSync(path.join(out,'preview-moved.png'),(await wc().capturePage()).toPNG());
 await evalUi('document.querySelector("#close").click()');await wait(40);
 assert.equal(view().getVisible(),false);const count=captures;
 state={...state,revision:2};notify(state);await wait(400);
 assert.equal(view().getVisible(),false);assert.equal(captures,count);assert.equal(actions.length,2);
 dispose.showTask('A');await wait(60);assert.equal(view().getVisible(),true);
 main.hide();await until(()=>!main.isVisible());await wait(200);
 console.log('Owner hidden: '+JSON.stringify({ownerVisible:main.isVisible(),viewVisible:view().getVisible()}));
 const hiddenCount=captures;await wait(400);assert.equal(captures,hiddenCount);
 main.show();await until(()=>main.isVisible()&&view().getVisible());
 main.minimize();await until(()=>main.isMinimized());await wait(200);
 const minimizedCount=captures;await wait(400);assert.equal(captures,minimizedCount);
 main.restore();main.show();await until(()=>!main.isMinimized()&&main.isVisible()&&view().getVisible());
 state={...state,revision:3,tasks:state.tasks.map(t=>({...t,phase:'completed'}))};notify(state);await wait(60);assert.equal(main.contentView.children.length,0);
 dispose();dispose=null;main.destroy();
 const result={passed:true,platform:process.platform,uiOnlyFixture:true,checks:['240x152 thumbnail with 8px stack offsets','live-only task list','switch and reorder','takeover/stop target identity','untrusted sender rejected','bounded move and persistence','close keeps tasks running and stops capture','owner hide/minimize/restore','terminal tasks remove surface']};
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log('PASS: '+JSON.stringify(result));app.exit(0);
}).catch(error=>{console.error(error);dispose?.();app.exit(1)});
`;
  await esbuild.build({ stdin: { contents: runner, resolveDir: base }, outfile: path.join(out, 'main.cjs'), bundle: true, platform: 'node', external: ['electron'], tsconfig: path.join(base, 'tsconfig.main.json'), alias: { '@shared': path.join(source, 'src/shared') } });
  if (process.argv.includes('--build-only')) { console.log('Built remote UI fixture: '+out); return; }
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require(path.join(base,'node_modules/electron')),[path.join(out,'main.cjs')],{env,encoding:'utf8',timeout:60000,killSignal:'SIGKILL'});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
  if(result.error)throw result.error;if(result.status!==0||!result.stdout?.includes('PASS:'))throw Error('UI fixture did not complete');
})().catch(error=>{console.error(error);process.exitCode=1});
