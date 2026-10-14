/** Real getDisplayMedia/preview/record integration. X11 delegation smoke and Wayland PipeWire are reported separately. */
import { app, BrowserWindow, nativeImage, screen, powerSaveBlocker } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScratchDir } from '../src/main/features/_kit/scratchDir';
import { createCapturePortalFrame, createRecordEngine } from '../src/main/features/capture/recorder';
import { createCaptureWindows } from '../src/main/features/capture/selectionWindows';
import { createCaptureService } from '../src/main/features/capture/captureService';
import { createNativeImageEncoder } from '../src/main/features/capture/stillEncoder';
import { resolveCaptureFfmpeg } from '../src/main/features/capture/encodingResources';
import { createResultStore } from '../src/main/features/capture/results';
import { configureCaptureBackend } from '../src/main/features/capture/linuxEnvironment';
import type { CaptureSelection } from '../src/shared/features/capture/windowContract';

configureCaptureBackend(app.commandLine);
const output=path.resolve(process.env.NUWAX_CAPTURE_ACCEPTANCE_DIR || 'capture-portal-results');
mkdirSync(output,{recursive:true});
const profile=mkdtempSync(path.join(output,'profile-'));
app.setPath('userData',profile);
app.on('window-all-closed',()=>{});
const report:Record<string,any>={platform:process.platform,arch:process.arch,session:process.env.XDG_SESSION_TYPE,checks:[],startedAt:new Date().toISOString()};
const animated=process.env.NUWAX_CAPTURE_STATIC_BOARD!=='1';report.animated=animated;
const save=()=>writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
const delay=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const scratch=createScratchDir(path.join(output,'scratch'));
let windows:ReturnType<typeof createCaptureWindows>|undefined,engine:ReturnType<typeof createRecordEngine>|undefined,service:ReturnType<typeof createCaptureService>|undefined;
let blocker:number|undefined;
const cleanup=()=>{service?.endSession();engine?.dispose();windows?.dispose();for(const w of BrowserWindow.getAllWindows())w.destroy();if(blocker!==undefined&&powerSaveBlocker.isStarted(blocker))powerSaveBlocker.stop(blocker);};
const deadline=setTimeout(()=>{report.error='deadline';save();cleanup();app.exit(1);},120000);
async function until<T>(read:()=>Promise<T>|T,predicate:(value:T)=>boolean){for(let i=0;i<1000;i++){const value=await read();if(predicate(value))return value;await delay();}throw Error('Portal UI timed out');}
async function initialStaticSourceDamage(board:BrowserWindow){
 if(animated)return;
 // chooser_type=none has no visible system picker to damage a completely
 // static output. Repaint once after the grant, like closing the client's
 // menu; no timer/animation runs during the later recording-start barrier.
 await until(async()=>{for(const w of BrowserWindow.getAllWindows())if(!w.webContents.isLoadingMainFrame()&&w.webContents.getURL().endsWith('/recording.html')&&await w.webContents.executeJavaScript("Boolean(document.querySelector('video')?.srcObject)").catch(()=>false))return true;return false;},Boolean);
 await board.webContents.executeJavaScript("(async()=>{document.body.style.outline='6px solid white';document.body.style.outlineOffset='-6px';await new Promise(r=>setTimeout(r,120));document.body.style.outline='none'})()");
}
async function confirmRegion(){
 const selector=await until(async()=>{for(const w of BrowserWindow.getAllWindows())if(!w.webContents.isLoadingMainFrame()&&await w.webContents.executeJavaScript("Boolean(document.querySelector('.frame'))").catch(()=>false))return w;return null;},Boolean);
 assert.ok(selector);
 const viewport=await until(()=>selector.webContents.executeJavaScript("(()=>{const r=document.querySelector('.frame').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()"),r=>r.width>0&&r.height>0);
 for(const [type,x,y] of [['mouseDown',.15,.2],['mouseMove',.65,.7],['mouseUp',.65,.7]] as const){selector.webContents.sendInputEvent({type,x:Math.round(viewport.x+viewport.width*x),y:Math.round(viewport.y+viewport.height*y),button:'left',clickCount:1});await delay();}
 const p=await selector.webContents.executeJavaScript("(()=>{const r=document.querySelector('[data-action=confirm]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()");
 for(const type of ['mouseDown','mouseUp'] as const){selector.webContents.sendInputEvent({type,x:Math.round(p[0]),y:Math.round(p[1]),button:'left',clickCount:1});await delay();}
}
app.whenReady().then(async()=>{
 assert.equal(process.platform,'linux');blocker=powerSaveBlocker.start('prevent-display-sleep');
 const board=new BrowserWindow({width:1000,height:700,show:true,frame:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await board.loadURL('data:text/html,'+encodeURIComponent('<!doctype html><body style="margin:0;background:#26354b;color:#fff;font:26px sans-serif"><div style="background:#e83232;height:200px">Nuwax portal capture test</div><div style="background:#32d05a;height:200px" id="clock">Static screen</div><div style="background:#3265e8;height:300px"></div>'+(animated?'<script>setInterval(()=>document.querySelector("#clock").textContent=Date.now(),50)</script>':'')));
 await delay(500);
 const preloadPath=path.resolve('dist/preload/captureRecording.js');
 const frameProvider=createCapturePortalFrame({scratch,preloadPath});
 const first=frameProvider(new AbortController().signal);await initialStaticSourceDamage(board);const image=await first;
 report.source={width:image.width,height:image.height,selection:image.selection};
 writeFileSync(path.join(output,'portal-source.png'),Buffer.from(image.dataUrl.split(',')[1],'base64'));
 assert.equal(image.selection.coordinateSpace,'source');
 assert.equal('displayId' in image.selection,false);
 const displays=screen.getAllDisplays();report.displays=displays.map(d=>({id:d.id,bounds:d.bounds,scale:d.scaleFactor}));
 if(process.env.XDG_SESSION_TYPE==='x11'){
  const primary=screen.getPrimaryDisplay();assert.equal(image.width,Math.round(primary.size.width*primary.scaleFactor));assert.equal(image.height,Math.round(primary.size.height*primary.scaleFactor));
 }
 report.checks.push('real getDisplayMedia source snapshot with native dimensions');save();
 const viewer=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const viewerPath=path.join(profile,'viewer.html');writeFileSync(viewerPath,'<!doctype html><body></body>');await viewer.loadFile(viewerPath);
 const metrics=`(canvas)=>{const w=canvas.width,h=canvas.height,d=canvas.getContext('2d').getImageData(0,0,w,h).data;const rgb=(x,y)=>{const i=(y*w+x)*4;return [d[i],d[i+1],d[i+2]]};let hash=0,colored=0,samples=0;for(let y=0;y<h;y+=3)for(let x=0;x<w;x+=3){const p=rgb(x,y);hash=(Math.imul(hash,31)+p[0]+p[1]*3+p[2]*7)|0;if(Math.max(...p)-Math.min(...p)>65&&Math.max(...p)>100)colored++;samples++}const grid=[];for(let row=0;row<8;row++)for(let col=0;col<16;col++){const x=Math.round(50+(w-58)*col/15),y=Math.round(8+(h-16)*row/7);grid.push({x,y,rgb:rgb(x,y)})}return {width:w,height:h,hash,coloredRatio:colored/samples,grid}}`;
 const decode=async(format:'mp4'|'gif',file:string)=>{
  if(format==='gif')return viewer.webContents.executeJavaScript(`(async()=>{const decoder=new ImageDecoder({type:'image/gif',data:Uint8Array.from(atob('${readFileSync(file).toString('base64')}'),c=>c.charCodeAt(0))});await decoder.completed;await decoder.tracks.ready;const count=decoder.tracks.selectedTrack.frameCount;if(count<3)throw Error('GIF has too few frames: '+count);const frames=[];const metrics=${metrics};for(const index of [0,Math.floor(count*.7),count-1]){const {image}=await decoder.decode({frameIndex:index});const c=document.createElement('canvas');c.width=image.displayWidth;c.height=image.displayHeight;c.getContext('2d').drawImage(image,0,0);frames.push(metrics(c));image.close()}decoder.close();return {frameCount:count,frames}})()`);
  return viewer.webContents.executeJavaScript(`(async()=>{const v=document.createElement('video');v.muted=true;const event=n=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('video '+n+' timeout')),10000);v.addEventListener(n,()=>{clearTimeout(t);resolve()},{once:true});v.addEventListener('error',()=>{clearTimeout(t);reject(Error(v.error?.message))},{once:true})});const loaded=event('loadedmetadata');v.src=${JSON.stringify(pathToFileURL(file).href)};document.body.replaceChildren(v);await loaded;const playing=event('timeupdate');await v.play();await playing;const playbackTime=v.currentTime;v.pause();const duration=v.duration;const frames=[],metrics=${metrics};for(const t of [0,duration*.7,Math.max(.01,duration-.05)]){const seeking=event('seeked');v.currentTime=t;await seeking;const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);frames.push(metrics(c))}v.removeAttribute('src');v.load();return {duration,playbackTime,frames}})()`);
 };
 windows=createCaptureWindows({portal:true,preloadPath:path.resolve('dist/preload/captureWindow.js'),capturePortalFrame:frameProvider,log:console});
 let selected:CaptureSelection|undefined;
 const createControls=windows.createRecordingControls.bind(windows);
 windows.createRecordingControls=(selection,onAction)=>{selected=selection;return createControls(selection,onAction);};
 const ffmpeg=await resolveCaptureFfmpeg({resourceRoot:path.resolve(process.env.NUWAX_CAPTURE_RESOURCE_ROOT || 'resources/capture')});assert.ok(ffmpeg);
 engine=createRecordEngine({portal:true,windows,scratch,ffmpeg,preloadPath,log:console});
 const results=createResultStore(scratch);service=createCaptureService({platform:'linux',getPermission:()=> 'n/a',getDisplays:()=>displays,stillEngine:windows,stillEncoder:createNativeImageEncoder(),recordEngine:engine,results,log:console});
 for(const format of ['mp4','gif'] as const){
  const pending=service.record({output:format,fps:10,maxDurationMs:10000});
  await initialStaticSourceDamage(board);await confirmRegion();await until(()=>service!.getState(),s=>s==='recording');await delay(700);
  engine.pauseOrResume();await until(()=>service!.getState(),s=>s==='paused');await delay(350);
  engine.pauseOrResume();await until(()=>service!.getState(),s=>s==='recording');await delay(950);engine.stop();
  const result=await pending;assert.equal(result.success,true,JSON.stringify(result));if(!result.success)throw Error(JSON.stringify(result));
  const file=path.join(output,`portal-recording.${format}`);assert.ok(results.copyTo(result.resultId,file));assert.ok(result.width>16&&result.height>16);assert.ok(result.durationMs!>=1500);
  assert.deepEqual(service.readChunk(result.resultId,0,16),readFileSync(file).subarray(0,16));
  const decoding=await decode(format,file);assert.equal(decoding.frames.length,3);
  if(format==='mp4')assert.ok(decoding.playbackTime>0,'Playback must advance');
  assert.ok(selected);const reference=nativeImage.createFromDataURL(image.dataUrl),bitmap=reference.toBitmap(),referenceWidth=reference.getSize().width;
  for(const frame of decoding.frames){assert.equal(frame.width,result.width);assert.equal(frame.height,result.height);assert.ok(frame.coloredRatio>.15,`Black or incorrect capture frame: ${JSON.stringify(frame)}`);
   let polluted=0;for(const sample of frame.grid){const offset=((selected.crop.y+sample.y)*referenceWidth+selected.crop.x+sample.x)*4;const expected=[bitmap[offset+2],bitmap[offset+1],bitmap[offset]];if(sample.rgb.some((value:number,index:number)=>Math.abs(value-expected[index])>50))polluted++;}
   frame.pollutedRatio=polluted/frame.grid.length;assert.ok(frame.pollutedRatio<.02,`Recording controls or other UI leaked into a decoded frame: ${frame.pollutedRatio}`);delete frame.grid;
  }
  if(animated)assert.ok(new Set(decoding.frames.map((frame:any)=>frame.hash)).size>1,'Portal recording frames must move');
  service.release(result.resultId);assert.equal(service.readChunk(result.resultId,0,16),null);
  report.checks.push({format,width:result.width,height:result.height,durationMs:result.durationMs,bytes:readFileSync(file).length,selection:selected,pauseResumeStop:true,decoding});save();
 }
 const canceled=service.record({output:'mp4',fps:10});await initialStaticSourceDamage(board);await confirmRegion();await until(()=>service!.getState(),s=>s==='recording');service.cancel();assert.deepEqual(await canceled,{success:false,code:'canceled'});
 const next=service.screenshot({format:'png'});await initialStaticSourceDamage(board);await confirmRegion();const still=await next;assert.equal(still.success,true,JSON.stringify(still));if(!still.success)throw Error(JSON.stringify(still));assert.ok(results.copyTo(still.resultId,path.join(output,'after-cancel.png')));service.release(still.resultId);report.checks.push('canceling a live portal stream and subsequent screenshot reuse');
 service.endSession();engine.dispose();windows.dispose();assert.deepEqual(readdirSync(scratch.root),[]);assert.equal(BrowserWindow.getAllWindows().filter(w=>w!==board&&w!==viewer).length,0);report.checks.push('scratch/handle/window cleanup');report.success=true;
}).catch(error=>{report.success=false;report.error=String(error?.stack||error);}).finally(()=>{clearTimeout(deadline);cleanup();try{rmSync(profile,{recursive:true,force:true});report.profileRemoved=true;}catch(error){report.profileRemoved=false;report.profileCleanup=String(error);}report.completedAt=new Date().toISOString();save();console.log(JSON.stringify(report));app.exit(report.success?0:1);});
