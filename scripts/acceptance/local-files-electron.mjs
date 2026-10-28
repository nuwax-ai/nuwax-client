/** Real Electron smoke with isolated profile and fixture metadata server; no login/account/package claim.
 * Uses an existing ffmpeg (or NUWAX_QA_FFMPEG) to generate a local H.264 test clip.
 * Save/open/trash OS adapters use fixtures; the real feature, protocol, preload and IPC run.
 * --bundle-only <dir> prepares the same fixture for a Windows host without this checkout.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readPdfCharacterMaps } from "../../nuwax/scripts/pdf-character-maps.js";

const bundleIndex = process.argv.indexOf("--bundle-only");
const bundleArgument = bundleIndex < 0 ? null : process.argv[bundleIndex + 1];
if (bundleIndex >= 0 && (!bundleArgument || bundleArgument.startsWith("--")))
  throw new Error("Usage: local-files-electron.mjs [--bundle-only <dir>]");
const bundleDirectory = bundleArgument ? path.resolve(bundleArgument) : null;

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const shell = path.join(
  root,
  "nuwa-electron-shell/crates/agent-electron-client"
);
const source = path.join(root, "nuwa-electron-shell/crates/agent-electron-client/src");
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
import {prepareDesktopFeaturesBeforeReady, startDesktopFeatures, notifyFeatureSessionEnd, disposeDesktopFeatures} from ${importFrom(
  "main/features/index.ts"
)};
import {initBusinessRequestRouting} from ${importFrom(
  "main/services/businessRequestRouting.ts"
)};
import {LocalFilesRuntime, localFilesFeature} from ${importFrom(
  "main/features/local-files/index.ts"
)};
import {redactLocalFileUrl} from ${importFrom(
  "shared/features/local-files/contract.ts"
)};

const temp=process.env.NUWAX_LOCAL_FILES_FIXTURE;
const reportPath=process.env.NUWAX_LOCAL_FILES_REPORT;
app.setPath('userData',path.join(temp,'profile'));
app.commandLine.appendSwitch('no-proxy-server');
protocol.registerSchemesAsPrivileged(prepareDesktopFeaturesBeforeReady('nuwax',app.commandLine));
if(process.env.NUWAX_LOCAL_FILES_DEBUG){const original=LocalFilesRuntime.prototype.authorize;LocalFilesRuntime.prototype.authorize=function(details){const result=original.call(this,details);if(result!==undefined)console.log('POLICY',JSON.stringify({url:redactLocalFileUrl(details.url),result,type:details.resourceType,webContentsId:details.webContentsId,frameUrl:redactLocalFileUrl(details.frame?.url??''),processId:details.frame?.processId,routingId:details.frame?.routingId,parentUrl:redactLocalFileUrl(details.frame?.parent?.url??''),referrer:redactLocalFileUrl(details.referrer??'')}));return result;};}
const windows=[];const requests=[];const checks=[];const fixtureLimitations=[];
let server, origin, fileOrigin, bridgeContext, fileServer;
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
  await fs.writeFile(path.join(workspace,'index.html'),'<!doctype html><link rel="stylesheet" href="/api/computer/static/1/assets/style.css?customTargetDir="><script src="/api/computer/static/1/assets/app.js"></script><body>中文本机预览</body>');
  const media=await fs.open(path.join(workspace,'large.mp4'),'w');await media.truncate(110*1024*1024);await media.close();
  await fs.copyFile(path.join(temp,'playback.mp4'),path.join(workspace,'playback.mp4'));
  await fs.copyFile(path.join(temp,'chinese.pdf'),path.join(workspace,'chinese.pdf'));
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
    workspace:{getIdentity:()=>({sandboxId:'fixture-device',businessOrigins:[origin]}),resolveRoot:()=>workspace,getFileServerPort:()=>fileServer.address().port,isCurrentDocument:trusted}},
    [{...localFilesFeature,register:ctx=>new LocalFilesRuntime(ctx,{dialog,shell:{openPath:async()=>'',showItemInFolder:()=>{},trashItem:async file=>{await fs.rename(file,path.join(temp,'trashed-fixture'));}},fetch,session:session.defaultSession})}]);
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
  const absolute=await localCall(owner,'stat',{contextId:bridgeContext.contextId,path:path.join(workspace,'note.txt')});assert.equal(absolute.success,true);
  const escaped=await localCall(owner,'stat',{contextId:bridgeContext.contextId,path:'..'+path.sep+'outside.txt'});assert.equal(escaped.code,'permission-denied');
  pass('host absolute paths resolve and relative traversal is refused');
  assert.equal(capability.writable,true);
  for(const change of [
    {name:'native-created.txt',operation:'create',contents:'created'},
    {name:'native-created.txt',operation:'modify',contents:'edited in Electron'},
    {name:'native-renamed.txt',renameFrom:'native-created.txt',operation:'rename'},
  ])assert.equal((await localCall(owner,'updateFiles',bridgeContext.contextId,[change])).success,true);
  assert.equal(await fs.readFile(path.join(workspace,'native-renamed.txt'),'utf8'),'edited in Electron');
  const foreignWrite=await localCall(foreign,'updateFiles',bridgeContext.contextId,[{name:'native-renamed.txt',operation:'delete'}]);assert.equal(foreignWrite.code,'untrusted');
  assert.equal((await localCall(owner,'updateFiles',bridgeContext.contextId,[{name:'native-renamed.txt',operation:'delete'}])).success,true);
  assert.equal(await fs.readFile(path.join(temp,'trashed-fixture'),'utf8'),'edited in Electron');
  pass('native create/edit/rename/trash through real IPC preserves bytes and owner isolation',{trash:'fixture move; system recycle-bin UI requires installed-package acceptance'});
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
  // 只断开此隔离 Electron 会话的网络，不改用户机器或正在运行的客户端。
  await owner.webContents.session.setProxy({mode:'fixed_servers',proxyRules:'http=127.0.0.1:1;https=127.0.0.1:1',proxyBypassRules:'<-loopback>'});
  await owner.webContents.session.closeAllConnections();
  assert.equal((await request(owner,origin+'/offline-probe')).blocked,true);
  const offlinePreview=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'note.txt'})).data;
  assert.equal((await request(owner,offlinePreview.url)).text,'0123456789');
  pass('offline HTTP transport cannot block a newly authorized local file preview');
  // 真实预览库 + 未嵌入字体的中文 PDF，强制覆盖需要字符映射的首次断网渲染。
  await evaluate(owner,await fs.readFile(path.join(temp,'pdf-preview.js'),'utf8'));
  const pdf=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'chinese.pdf'})).data;
  const renderedPdf=await evaluate(owner,'window.renderOfflinePdf('+JSON.stringify(pdf.url)+')');
  assert.ok(renderedPdf.maps.includes('UniGB-UCS2-H'));
  assert.ok(renderedPdf.inkPixels>0);
  pass('offline Chinese PDF renders actual canvas pixels with bundled character maps',renderedPdf);
  const html=(await localCall(owner,'preparePreview',{contextId:bridgeContext.contextId,path:'index.html'})).data;
  await evaluate(owner,'window.fixtureMessages=[];window.addEventListener("message",event=>window.fixtureMessages.push(event.data));const iframe=document.createElement("iframe");iframe.sandbox="allow-scripts allow-same-origin";iframe.src='+JSON.stringify(html.url)+';iframe.id="local-preview";document.body.appendChild(iframe);');
  await waitFor(()=>evaluate(owner,'window.fixtureMessages.some(message=>message.type==="local-html-ready")'),'HTML legacy same-conversation CSS and JS resources');
  const htmlMessage=await evaluate(owner,'window.fixtureMessages.find(message=>message.type==="local-html-ready")');
  assert.equal(htmlMessage.bridge,'undefined');assert.equal(htmlMessage.electron,'undefined');assert.equal(htmlMessage.color,'rgb(31, 63, 127)');
  pass('sandboxed local HTML loads relative CSS/JS and has no host bridge');
  const localFrame=owner.webContents.mainFrame.frames.find(frame=>frame.url===html.url);assert.ok(localFrame);
  const relativeFetch=await localFrame.executeJavaScript('(async()=>{try{const response=await fetch(new URL("note.txt",location.href));return {status:response.status,text:await response.text()};}catch(error){return {error:String(error)};}})()');assert.equal(relativeFetch.status,200);assert.equal(relativeFetch.text,'0123456789');
  pass('offline local HTML still loads its local CSS, JavaScript and referenced file bytes');
  await owner.webContents.session.setProxy({mode:'direct'});
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
  const report={success:true,at:new Date().toISOString(),electron:process.versions.electron,platform:process.platform,arch:process.arch,checks,requestPaths:requests.map(request=>request.path),limitations:['Isolated real Electron runtime, fixture metadata server and stubbed save/open/trash adapters; not a signed installer, real-account or system recycle-bin acceptance.','Windows real-device execution remains separate.',...fixtureLimitations]};
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
  const content='BT /F1 32 Tf 50 700 Td <4F60597D4E2D6587> Tj ET';
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer << /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await fs.writeFile(path.join(temporary,'chinese.pdf'),pdf);
  await build({
    bundle:true,platform:'browser',format:'iife',target:'chrome120',
    stdin:{resolveDir:path.join(root,'nuwax'),loader:'ts',contents:`
      import pdf from '@js-preview/pdf';
      import {bundledPdfResources} from './src/components/business-component/FilePreview/pdfCharacterMaps';
      window.renderOfflinePdf=async url=>{
        const bytes=await (await fetch(url,{credentials:'omit'})).arrayBuffer();
        const host=document.createElement('div');host.style.cssText='width:800px;height:600px';document.body.appendChild(host);
        const maps=[];class TracedMaps extends bundledPdfResources.CMapReaderFactory{fetch(input){maps.push(input.name);return super.fetch(input);}}
        return new Promise((resolve,reject)=>{
          const preview=pdf.init(host,{...bundledPdfResources,CMapReaderFactory:TracedMaps,width:780,onError:reject,onRendered:()=>{
            const canvas=host.querySelector('canvas');if(!canvas)return reject(Error('No PDF canvas'));
            const rgba=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
            let inkPixels=0;for(let i=0;i<rgba.length;i+=4)if(rgba[i+3]&&rgba[i]+rgba[i+1]+rgba[i+2]<600)inkPixels++;
            resolve({maps,inkPixels,canvases:host.querySelectorAll('canvas').length});preview.destroy();
          }});preview.preview(bytes);
        });
      };
    `},
    define:{NUWAX_PDF_CMAPS:JSON.stringify(readPdfCharacterMaps())},
    outfile:path.join(temporary,'pdf-preview.js'),
  });
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
  if (bundleDirectory) {
    await fs.mkdir(bundleDirectory, { recursive: true });
    for (const file of ["main.cjs", "preload.cjs", "playback.mp4", "chinese.pdf", "pdf-preview.js"])
      await fs.copyFile(path.join(temporary, file), path.join(bundleDirectory, file));
    console.log(`LOCAL_FILES_ELECTRON_BUNDLE ${bundleDirectory}`);
  } else {
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
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
