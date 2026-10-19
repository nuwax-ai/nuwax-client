/** Real Electron smoke with isolated profile and fixture metadata server; no login/account/package claim.
 * Uses an existing ffmpeg (or NUWAX_QA_FFMPEG) to generate a local H.264 test clip.
 * The save dialog is fixture-selected; the real feature, protocol, preload and IPC run unmodified.
 * `--bundle-only <dir>` writes main.cjs/preload.cjs/playback.mp4 for a host without this checkout
 * (see local-files-electron-windows.ps1) instead of launching Electron here.
 * NUWAX_QA_REAL_FILE_SERVER_PORT additionally lists/searches the fixture workspace through a running
 * nuwax-file-server on that loopback port (read-only).
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const bundleOnlyIndex = process.argv.indexOf("--bundle-only");
const bundleOnlyArg =
  bundleOnlyIndex === -1 ? undefined : process.argv[bundleOnlyIndex + 1];
if (bundleOnlyIndex !== -1 && !bundleOnlyArg) {
  console.error("Usage: local-files-electron.mjs [--bundle-only <dir>]");
  process.exit(1);
}
const bundleOnly = bundleOnlyArg ? path.resolve(bundleOnlyArg) : null;

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const shell = path.join(
  root,
  "nuwa-electron-shell/crates/agent-electron-client"
);
const source = path.join(root, "overlay/crates/agent-electron-client/src");
const requireShell = createRequire(path.join(shell, "package.json"));
const { build } = requireShell("esbuild");
const temporary = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-local-files-electron-"))
);
const reportPath = path.join(
  root,
  ".cache/acceptance/local-files-electron.json"
);
const importFrom = (relative) => JSON.stringify(path.join(source, relative));

async function createVideoFixture() {
  const child = spawn(
    process.env.NUWAX_QA_FFMPEG || "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=160x90:r=15:d=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      path.join(temporary, "playback.mp4"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exit !== 0)
    throw new Error(`ffmpeg fixture generation failed: ${errors}`);
}

const preload = `
  import {contextBridge, ipcRenderer} from 'electron';
  import {createLocalFilesBridge} from ${importFrom(
    "preload/features/local-files.ts"
  )};
  contextBridge.exposeInMainWorld('NuwaClawBridge', {localFiles: createLocalFilesBridge(ipcRenderer)});
`;
const main = String.raw`
import {app, BrowserWindow, ipcMain, protocol, session, dialog} from 'electron';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {desktopFeatureSchemes, startDesktopFeatures, notifyFeatureSessionEnd, disposeDesktopFeatures} from ${importFrom(
  "main/features/index.ts"
)};
import {initBusinessRequestRouting} from ${importFrom(
  "main/services/businessRequestRouting.ts"
)};
import {LocalFilesRuntime} from ${importFrom(
  "main/features/local-files/index.ts"
)};
import {redactLocalFileUrl} from ${importFrom(
  "shared/features/local-files/contract.ts"
)};

const temp=process.env.NUWAX_LOCAL_FILES_FIXTURE;
const reportPath=process.env.NUWAX_LOCAL_FILES_REPORT;
app.setPath('userData',path.join(temp,'profile'));
app.commandLine.appendSwitch('no-proxy-server');
protocol.registerSchemesAsPrivileged(desktopFeatureSchemes('nuwax'));
if(process.env.NUWAX_LOCAL_FILES_DEBUG){const original=LocalFilesRuntime.prototype.authorize;LocalFilesRuntime.prototype.authorize=function(details){const result=original.call(this,details);if(result!==undefined)console.log('POLICY',JSON.stringify({url:redactLocalFileUrl(details.url),result,type:details.resourceType,webContentsId:details.webContentsId,frameUrl:redactLocalFileUrl(details.frame?.url??''),processId:details.frame?.processId,routingId:details.frame?.routingId,parentUrl:redactLocalFileUrl(details.frame?.parent?.url??''),referrer:redactLocalFileUrl(details.referrer??'')}));return result;};}
const windows=[];const requests=[];const checks=[];const fixtureLimitations=[];
let server, origin, fileOrigin, bridgeContext, fileServer;
const realFileServerPort=Number(process.env.NUWAX_QA_REAL_FILE_SERVER_PORT)||0;let realFileServerActive=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const workspace=path.join(temp,'workspace');
const pass=(name,data={})=>{checks.push({name,...data});console.log('PASS '+name);};
async function waitFor(check,label){const until=Date.now()+15000;while(Date.now()<until){if(await check())return;await sleep(40);}throw Error('Timeout: '+label);}
function evaluate(window,code){return window.webContents.executeJavaScript(code,true);}
function localCall(window,name,...args){return evaluate(window,'window.NuwaClawBridge.localFiles.'+name+'(...'+JSON.stringify(args)+')');}
async function request(window,url,init={}){return evaluate(window,'(async()=>{try{const r=await fetch('+JSON.stringify(url)+','+JSON.stringify(init)+');return {ok:r.ok,status:r.status,headers:Object.fromEntries(r.headers.entries()),text:await r.text()};}catch(error){return {blocked:true,error:String(error)};}})()');}
(async()=>{
try {
  await fs.mkdir(path.join(workspace,'assets'),{recursive:true});
  await fs.writeFile(path.join(workspace,'note.txt'),'0123456789');
  await fs.writeFile(path.join(workspace,'assets/app.js'),
    'window.addEventListener("load",()=>{document.body.dataset.ready="yes";parent.postMessage({type:"local-html-ready",bridge:typeof window.NuwaClawBridge,electron:typeof window.electronAPI,color:getComputedStyle(document.body).color},"*")});');
  await fs.writeFile(path.join(workspace,'assets/style.css'),'body {color:rgb(31,63,127)}');
  await fs.writeFile(path.join(workspace,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="assets/style.css"><script src="assets/app.js"></script><body>Relative resources</body>');
  const media=await fs.open(path.join(workspace,'large.mp4'),'w');await media.truncate(110*1024*1024);await media.close();
  await fs.copyFile(path.join(temp,'playback.mp4'),path.join(workspace,'playback.mp4'));
  await fs.mkdir(path.join(workspace,'.hidden'));await fs.mkdir(path.join(workspace,'empty'));
  await fs.writeFile(path.join(workspace,'.hidden/note.txt'),'hidden fixture');
  await fs.writeFile(path.join(workspace,'hard-source.txt'),'hard fixture');
  await fs.link(path.join(workspace,'hard-source.txt'),path.join(workspace,'hard.txt'));
  await fs.writeFile(path.join(temp,'outside.txt'),'outside target must not be dereferenced');
  let symlinkSupported=true;
  try{await fs.symlink('../outside.txt',path.join(workspace,'soft.txt'));}catch(error){if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){symlinkSupported=false;fixtureLimitations.push('Windows symlink fixture requires permission; symlink ZIP verification skipped.');}else throw error;}
  await app.whenReady();
  if(process.env.NUWAX_LOCAL_FILES_DEBUG)session.defaultSession.webRequest.onErrorOccurred(details=>console.log('NETWORK_ERROR',JSON.stringify({url:redactLocalFileUrl(details.url),error:details.error,method:details.method,type:details.resourceType})));
  if(process.env.NUWAX_LOCAL_FILES_DEBUG){const original=session.defaultSession.protocol.handle.bind(session.defaultSession.protocol);session.defaultSession.protocol.handle=(scheme,handler)=>original(scheme,async request=>{try{const response=await handler(request);console.log('PROTOCOL_RESPONSE',JSON.stringify({method:request.method,status:response.status,headers:Object.fromEntries(response.headers.entries()),origin:request.headers.get('origin')}));return response;}catch(error){console.log('PROTOCOL_ERROR',String(error));throw error;}});}
  server=createServer((req,res)=>{
    requests.push({method:req.method,path:req.url});
    res.setHeader('Content-Type','text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Local files smoke</title><body>fixture</body>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  fileServer=createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    requests.push({method:req.method,path:url.pathname,customTargetDir:url.searchParams.get('customTargetDir'),cookie:!!req.headers.cookie,authorization:!!req.headers.authorization});
    assert.equal(url.searchParams.get('customTargetDir'),workspace);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({success:true,files:[{name:'note.txt',isDir:false}],recursive:false,type:'all',depth:2,limit:null}));
  });
  await new Promise(resolve=>fileServer.listen(0,'127.0.0.1',resolve));fileOrigin='http://127.0.0.1:'+fileServer.address().port;
  const trusted=event=>!!event.senderFrame&&!event.senderFrame.parent&&windows.some(window=>window.webContents===event.sender)&&event.senderFrame.url.startsWith(origin+'/');
  initBusinessRequestRouting(()=>origin,()=>windows[0]?.webContents??null);
  startDesktopFeatures({product:'nuwax',ipcMain,isBusinessSender:trusted,isHostSender:()=>false,dataDir:path.join(temp,'features'),isEnabled:(_id,value)=>value,log:console,
    workspace:{getIdentity:()=>({sandboxId:'fixture-device',businessOrigins:[origin]}),resolveRoot:()=>workspace,getFileServerPort:()=>realFileServerActive?realFileServerPort:fileServer.address().port,isCurrentDocument:trusted}});
  async function makeWindow(){const window=new BrowserWindow({show:false,webPreferences:{preload:path.join(temp,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});if(process.env.NUWAX_LOCAL_FILES_DEBUG)window.webContents.on('console-message',(_event,_level,message)=>console.log('RENDERER',redactLocalFileUrl(message)));windows.push(window);await window.loadURL(origin+'/');return window;}
  const owner=await makeWindow();const foreign=await makeWindow();
  const capability=await localCall(owner,'getCapabilities');assert.equal(capability.available,true);
  const resolved=await localCall(owner,'resolveContext',{cId:1,sandboxId:'fixture-device',userId:99});assert.equal(resolved.success,true);bridgeContext=resolved.data;
  if(process.env.NUWAX_LOCAL_FILES_DEBUG)console.log('PROTOCOL_INSTALLED',await owner.webContents.session.protocol.isProtocolHandled('nuwax-local'),owner.webContents.session===session.defaultSession,process.versions.electron);
  pass('real Electron + registry + preload + trusted context',{electron:process.versions.electron});
  const listed=await localCall(owner,'listFiles',bridgeContext.contextId,{recursive:false,depth:2});assert.equal(listed.data.files[0].name,'note.txt');
  const searched=await localCall(owner,'searchFiles',bridgeContext.contextId,{kw:'note'});assert.equal(searched.success,true);
  assert.ok(requests.filter(request=>request.customTargetDir).every(request=>!request.cookie&&!request.authorization));
  pass('main-process list/search fixture server without cloud credentials',{server:'fixture metadata (native endpoint shape)'});
  if(realFileServerPort){
    realFileServerActive=true;
    try{
      const realList=await localCall(owner,'listFiles',bridgeContext.contextId,{recursive:false,depth:2});assert.equal(realList.success,true,JSON.stringify(realList));
      const realNames=realList.data.files.map(file=>file.name);assert.ok(realNames.includes('note.txt')&&realNames.includes('index.html'),JSON.stringify(realNames));
      const realSearch=await localCall(owner,'searchFiles',bridgeContext.contextId,{kw:'style'});assert.equal(realSearch.success,true,JSON.stringify(realSearch));
      assert.ok(realSearch.data.files.some(file=>file.name==='assets/style.css'),JSON.stringify(realSearch.data.files));
      pass('main-process list/search against a real nuwax-file-server',{port:realFileServerPort,listed:realNames.length});
    }finally{realFileServerActive=false;}
  }
  const preview=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'note.txt'})).data;
  const full=await request(owner,preview.url);if(process.env.NUWAX_LOCAL_FILES_DEBUG)console.log('FETCH_RESULT',full);assert.equal(full.status,200);assert.equal(full.text,'0123456789');
  const head=await request(owner,preview.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.text,'');assert.equal(head.headers['content-length'],'10');
  const range=await request(owner,preview.url,{headers:{Range:'bytes=3-6'}});assert.equal(range.status,206);assert.equal(range.text,'3456');assert.equal(range.headers['content-range'],'bytes 3-6/10');
  const invalid=await request(owner,preview.url,{headers:{Range:'bytes=30-'}});assert.equal(invalid.status,416);
  pass('GET / HEAD / single Range / 416 with exact bytes');
  await evaluate(owner,'history.pushState({},"","/?panel=files#preview");');
  assert.equal((await request(owner,preview.url)).text,'0123456789');
  assert.equal((await localCall(owner,'stat',{contextId:bridgeContext.contextId,path:'note.txt'})).success,true);
  pass('same-document history/query/hash preserves context and grant');
  const foreignRead=await request(foreign,preview.url);assert.equal(foreignRead.blocked,true);
  const foreignStat=await localCall(foreign,'stat',{contextId:bridgeContext.contextId,path:'note.txt'});assert.equal(foreignStat.code,'untrusted');
  pass('cross-window protocol and IPC blocked');
  const big=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'large.mp4'})).data;
  const bigRange=await request(owner,big.url,{headers:{Range:'bytes=104857600-104857609'}});assert.equal(bigRange.status,206);assert.equal(bigRange.text.length,10);assert.equal(bigRange.headers['x-file-size'],String(110*1024*1024));
  pass('110MiB media served by a ten-byte Range without whole-file buffering');
  const playable=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'playback.mp4'})).data;
  const playback=await evaluate(owner,'(async()=>{const video=document.createElement("video");video.muted=true;video.preload="auto";video.src='+JSON.stringify(playable.url)+';document.body.appendChild(video);const event=name=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error("Video event timeout: "+name)),10000);video.addEventListener(name,()=>{clearTimeout(timeout);resolve();},{once:true});video.addEventListener("error",()=>{clearTimeout(timeout);reject(Error("Video decode error: "+video.error?.code));},{once:true});});try{await event("loadedmetadata");const duration=video.duration;await video.play();await new Promise(resolve=>setTimeout(resolve,350));const before=video.currentTime;video.pause();const seeked=event("seeked");video.currentTime=2.5;await seeked;await video.play();await new Promise(resolve=>setTimeout(resolve,250));video.pause();const canvas=document.createElement("canvas");canvas.width=1;canvas.height=1;const context=canvas.getContext("2d");context.drawImage(video,0,0,1,1);return {duration,before,after:video.currentTime,width:video.videoWidth,height:video.videoHeight,pixel:Array.from(context.getImageData(0,0,1,1).data)};}finally{video.remove();}})()');
  assert.ok(playback.duration>=3.9);assert.ok(playback.before>0.1);assert.ok(playback.after>2.5);assert.equal(playback.width,160);assert.equal(playback.height,90);assert.ok(playback.pixel[0]>150&&playback.pixel[1]<80&&playback.pixel[2]<80);
  pass('real video element decodes H.264, plays and seeks through the local protocol',{fixture:'ffmpeg-generated four-second H.264 MP4',duration:playback.duration,playedTo:playback.before,soughtTo:playback.after,decodedPixel:playback.pixel});
  const zipPath=path.join(workspace,'complete.zip');await fs.writeFile(zipPath,'old fixture output');
  const workspaceAlias=path.join(temp,'workspace-alias');await fs.symlink(workspace,workspaceAlias,process.platform==='win32'?'junction':'dir');
  const originalSaveDialog=dialog.showSaveDialog;
  let exported;
  try{dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(workspaceAlias,'complete.zip')});exported=await localCall(owner,'exportWorkspace',bridgeContext.contextId,{fileName:'complete.zip',operationId:'fixture-export'});}finally{dialog.showSaveDialog=originalSaveDialog;}
  assert.equal(exported.success,true);assert.equal(exported.data.canceled,false);
  const zip=new AdmZip(zipPath);const zipNames=zip.getEntries().map(entry=>entry.entryName);
  assert.equal(zip.readAsText('workspace/.hidden/note.txt'),'hidden fixture');assert.ok(zipNames.includes('workspace/empty/'));
  assert.equal(zip.readAsText('workspace/hard.txt'),'hard fixture');assert.equal(zip.readAsText('workspace/hard-source.txt'),'hard fixture');
  assert.equal(zip.getEntry('workspace/large.mp4').header.size,110*1024*1024);
  if(symlinkSupported){assert.equal(zip.readAsText('workspace/soft.txt'),'../outside.txt');assert.equal((zip.getEntry('workspace/soft.txt').header.attr>>>16)&0o170000,0o120000);}
  assert.equal(zipNames.includes('workspace/complete.zip'),false);assert.equal(zipNames.some(name=>name.includes('.nuwax-')),false);
  assert.equal((await fs.readdir(workspace)).some(name=>name.includes('.nuwax-')),false);
  pass('real Electron export IPC exports a workspace above 100MiB with hidden/hardlink/symlink/empty entries',{saveDialog:'fixture-selected destination; no human installer action',uncompressedLargeFile:110*1024*1024,symlinkVerified:symlinkSupported,entryCount:zipNames.length});
  const html=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'index.html'})).data;
  await evaluate(owner,'window.fixtureMessages=[];window.addEventListener("message",event=>window.fixtureMessages.push(event.data));const iframe=document.createElement("iframe");iframe.sandbox="allow-scripts allow-same-origin";iframe.src='+JSON.stringify(html.url)+';iframe.id="local-preview";document.body.appendChild(iframe);');
  await waitFor(()=>evaluate(owner,'window.fixtureMessages.some(message=>message.type==="local-html-ready")'),'HTML CSS JS relative resources');
  const htmlMessage=await evaluate(owner,'window.fixtureMessages.find(message=>message.type==="local-html-ready")');
  assert.equal(htmlMessage.bridge,'undefined');assert.equal(htmlMessage.electron,'undefined');assert.equal(htmlMessage.color,'rgb(31, 63, 127)');
  pass('sandboxed local HTML loads relative CSS/JS and has no host bridge');
  const localFrame=owner.webContents.mainFrame.frames.find(frame=>frame.url===html.url);assert.ok(localFrame);
  const relativeFetch=await localFrame.executeJavaScript('(async()=>{try{const response=await fetch(new URL("note.txt",location.href));return {status:response.status,text:await response.text()};}catch(error){return {error:String(error)};}})()');assert.equal(relativeFetch.status,200);assert.equal(relativeFetch.text,'0123456789');
  const forbidden=await localFrame.executeJavaScript('(async()=>{try{await fetch('+JSON.stringify(origin+'/api/private')+');return false;}catch{return true;}})()');assert.equal(forbidden,true);
  pass('local HTML cannot call business/loopback endpoints');
  await localFrame.executeJavaScript('location.href="data:text/plain,preview";');
  await sleep(150);
  assert.equal(owner.webContents.mainFrame.frames.find(frame=>frame.frameTreeNodeId===localFrame.frameTreeNodeId)?.url,html.url);
  pass('production HTML sandbox blocks navigation to an opaque document');
  if(symlinkSupported){
    const linked=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'soft.txt'})).data;
    assert.equal((await request(owner,linked.url)).text,'outside target must not be dereferenced');
    const relativeLink=await request(owner,new URL('soft.txt',html.url).href);assert.equal(relativeLink.status,403);
    pass('explicit symlink file reads work while relative resources cannot escape the grant root');
  }
  const explicitPath=path.join(temp,'explicit-outside.txt');await fs.writeFile(explicitPath,'explicit absolute read');
  const absoluteForms=process.platform==='win32'?[explicitPath,explicitPath.replace(/\\/g,'/')]:[explicitPath];
  for(const form of absoluteForms){const absolute=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:form})).data;assert.equal((await request(owner,absolute.url)).text,'explicit absolute read');}
  const backslash=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'assets\\style.css'})).data;assert.equal((await request(owner,backslash.url)).text,'body {color:rgb(31,63,127)}');
  const escaping=await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'..\\explicit-outside.txt'});assert.equal(escaping.code,'permission-denied');
  pass('host path semantics: explicit absolute files read, backslash-relative paths resolve, relative escape denied',{absoluteForms:absoluteForms.length});
  await localCall(owner,'releasePreview',preview.grantId);assert.equal((await request(owner,preview.url)).blocked,true);
  pass('release revokes the protocol grant');
  notifyFeatureSessionEnd('logout');assert.equal((await request(owner,big.url,{method:'HEAD'})).blocked,true);
  const expired=await localCall(owner,'stat',{contextId:bridgeContext.contextId,path:'note.txt'});assert.equal(expired.code,'expired');
  pass('auth boundary revokes protocol and IPC contexts');
  const freshContext=(await localCall(owner,'resolveContext',{cId:1,sandboxId:'fixture-device',userId:99})).data;
  const freshPreview=(await localCall(owner,'preparePreview',{contextId:freshContext.contextId,path:'note.txt'})).data;
  await owner.loadURL(origin+'/');
  assert.equal((await request(owner,freshPreview.url)).blocked,true);
  assert.equal((await localCall(owner,'stat',{contextId:freshContext.contextId,path:'note.txt'})).code,'expired');
  pass('full document reload revokes context and grant');
  assert.equal(requests.some(request=>request.path.startsWith('/api/computer/static/')),false);
  pass('successful local byte access makes no cloud static-file request');
  const report={success:true,at:new Date().toISOString(),electron:process.versions.electron,platform:process.platform,arch:process.arch,checks,requestPaths:requests.map(request=>request.path),limitations:['Isolated real Electron runtime, fixture metadata server and stubbed save dialog; not a signed installer or real-account acceptance.',...(process.platform==='win32'?[]:['Windows real-device execution remains separate.']),...fixtureLimitations]};
  await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log('LOCAL_FILES_ELECTRON_PASS '+reportPath);
} catch(error) {
  console.error('LOCAL_FILES_ELECTRON_FAIL',error);
  await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify({success:false,at:new Date().toISOString(),electron:process.versions.electron,checks,error:String(error)},null,2)+'\n');
  process.exitCode=1;
} finally {
  await disposeDesktopFeatures();for(const window of windows)if(!window.isDestroyed())window.destroy();
  await new Promise(resolve=>server?server.close(resolve):resolve());await new Promise(resolve=>fileServer?fileServer.close(resolve):resolve());
  app.exit(process.exitCode??0);
}
})().catch(error=>{console.error('LOCAL_FILES_ELECTRON_FATAL',error);app.exit(1);});
`;

try {
  await createVideoFixture();
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    alias: {
      "@shared": path.join(source, "shared"),
      "@main": path.join(source, "main"),
      "@renderer": path.join(source, "renderer"),
    },
    nodePaths: [
      path.join(shell, "node_modules"),
      path.join(root, "node_modules"),
    ],
  };
  await build({
    ...common,
    stdin: { contents: preload, resolveDir: shell, loader: "ts" },
    outfile: path.join(temporary, "preload.cjs"),
  });
  await build({
    ...common,
    stdin: { contents: main, resolveDir: shell, loader: "ts" },
    outfile: path.join(temporary, "main.cjs"),
  });
  if (bundleOnly) {
    await fs.mkdir(bundleOnly, { recursive: true });
    for (const name of ["main.cjs", "preload.cjs", "playback.mp4"])
      await fs.copyFile(path.join(temporary, name), path.join(bundleOnly, name));
    console.log(`LOCAL_FILES_ELECTRON_BUNDLE ${bundleOnly}`);
  } else {
    await launch();
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

async function launch() {
  const env = {
    ...process.env,
    NUWAX_LOCAL_FILES_FIXTURE: temporary,
    NUWAX_LOCAL_FILES_REPORT: reportPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.NUWAX_QA_ELECTRON || requireShell("electron");
  const child = spawn(executable, [path.join(temporary, "main.cjs")], {
    env,
    stdio: "inherit",
  });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 60000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  clearTimeout(watchdog);
  process.exitCode = timedOut ? 1 : exit;
  if (timedOut) console.error("LOCAL_FILES_ELECTRON_TIMEOUT");
}
