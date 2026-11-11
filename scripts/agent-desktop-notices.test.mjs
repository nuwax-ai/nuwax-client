import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateThirdPartyNotices } from './client/source-notices.mjs';
import { prepareReleaseNotices,verifyReleaseNotices } from './prepare-release-notices.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nuwax-desktop-licenses-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=JSON.parse(fs.readFileSync(path.join(root,'third-party/source-components.json')));
 fs.cpSync(path.join(root,'third-party/agent-desktop'),path.join(dir,'third-party/agent-desktop'),{recursive:true});
 fs.mkdirSync(path.join(dir,'third-party/licenses'),{recursive:true});
 fs.copyFileSync(path.join(root,'third-party/licenses/agent-desktop.txt'),path.join(dir,'third-party/licenses/agent-desktop.txt'));
 write(path.join(dir,'third-party/source-components.json'),{schema:1,components:{'agent-desktop':source.components['agent-desktop']},allow:source.allow});
 write(path.join(dir,'third-party/manifest.json'),{schema:1,resources:{},npmRoots:[]});
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,source.components['agent-desktop'].licenseInventory)));
 const resources=path.join(dir,'resources/agent-desktop');
 for (const target of manifest.targets) write(path.join(resources,target,'source.json'),{version:manifest.version,integrity:manifest.integrity,
  ...(target==='win32-x64'?{nativeBuild:{revision:manifest.revision,toolchain:'1.97.1'}}:{})});
 const generate=(target,paths={'agent-desktop':resources})=>{
  const [platform,arch]=target.split('-');
  return generateThirdPartyNotices(dir,{outDir:path.join(dir,'out',target),resourcePaths:paths,platform,arch,strict:true});
 };
 const update=()=>{const file=path.join(dir,'third-party/agent-desktop/inventory.json');write(file,manifest);
  const sourceFile=path.join(dir,'third-party/source-components.json'),s=JSON.parse(fs.readFileSync(sourceFile));
  s.components['agent-desktop'].licenseInventorySha256=hash(fs.readFileSync(file));write(sourceFile,s);};
 return {dir,manifest,resources,generate,update};
}
test('five shipped targets expose the main component, exact native closure, runtime attribution and readable full licenses',t=>{
 const f=fixture(t),counts={'darwin-arm64':57,'darwin-x64':57,'win32-x64':77,'linux-x64':115,'linux-arm64':115};
 for (const [target,count] of Object.entries(counts)) {
  const result=f.generate(target),rows=result.document.components;
  assert.equal(rows.length,count+2,target);
  const main=rows.find(c=>c.id==='agent-desktop');
  assert.equal(main.modified,target.startsWith('win32'));
  assert.match(main.notes,target.startsWith('win32')?/automation\.rs/:/未修改/);
  assert.equal(rows.filter(c=>c.name==='uiautomation (Agent Desktop)').length,target.startsWith('win32')?1:0);
  assert.equal(rows.filter(c=>c.name==='accessibility-sys (Agent Desktop)').length,target.startsWith('darwin')?1:0);
  for(const c of rows) {
   assert.match(c.licenseText,/^licenses\/[A-Za-z0-9._-]+\.txt$/);
   const text=fs.readFileSync(path.join(result.outDir,c.licenseText),'utf8');
   assert.ok(text.length>100);assert.ok(Buffer.byteLength(text)<1024*1024);
  }
  const unicode=rows.find(c=>c.id==='agent-desktop-crate-unicode-ident-1.0.24');
  assert.match(fs.readFileSync(path.join(result.outDir,unicode.licenseText),'utf8'),/UNICODE LICENSE V3/);
 }
 assert.equal(f.generate('darwin-arm64',{}).document.components.length,0);
});
test('missing or changed license evidence fails before writing packaged notices',t=>{
 const f=fixture(t),entry=f.manifest.components.find(c=>c.name.startsWith('uiautomation '));
 fs.appendFileSync(path.join(f.dir,entry.licenseFile),'\nchanged');
 assert.throws(()=>f.generate('darwin-arm64'),/Evidence SHA256/);
 assert.equal(fs.existsSync(path.join(f.dir,'out/darwin-arm64/third-party-notices.json')),false);
});
test('inventory/version, source payload and Windows compiler changes require a fresh audit',t=>{
 const f=fixture(t);
 f.manifest.version='9.9.9';f.update();
 assert.throws(()=>f.generate('darwin-arm64'),/Stale/);
 f.manifest.version='1.2.0';f.update();
 write(path.join(f.resources,'win32-x64/source.json'),{version:f.manifest.version,integrity:f.manifest.integrity,nativeBuild:{revision:f.manifest.revision,toolchain:'1.98.0'}});
 assert.throws(()=>f.generate('win32-x64'),/toolchain attribution/);
});
test('an edited inventory cannot broaden license admission or read paths outside the audited evidence directory',t=>{
 const f=fixture(t),entry=f.manifest.components.find(c=>c.license.includes('Unicode'));
 entry.license='GPL-3.0-only';f.update();
 assert.throws(()=>f.generate('linux-x64'),/Unreviewed/);
 entry.license='MIT';entry.licenseFile='../outside.txt';f.update();
 assert.throws(()=>f.generate('linux-x64'),/Invalid evidence/);
});
test('formal release injects and verifies complete notices while reusing existing capture source archives once',t=>{
 const f=fixture(t),client=path.join(f.dir,'nuwa-electron-shell/crates/agent-electron-client');
 const capture=path.join(f.dir,'capture-notices'),archive='locked FFmpeg source',license='Apache License version 2.0 full fixture license';
 write(path.join(capture,'sources/ffmpeg.tar.xz'),archive);
 const signedCapture=path.join(f.dir,'.cache/release-capture-signed/darwin-arm64');
 write(path.join(client,'package.json'),{build:{extraResources:[{from:capture,to:'third-party/capture'},{from:'old',to:'third-party'},
  {from:signedCapture,to:'capture/darwin-arm64'}]}});
 const generate=(_root,{outDir,resourcePaths})=>{
  assert.equal(resourcePaths.capture,signedCapture);
  const document={schema:1,components:[{id:'ffmpeg',usedBy:'capture',sourceArchive:'sources/ffmpeg.tar.xz',sourceSha256:hash(archive)},
   {id:'agent-desktop',licenseText:'licenses/agent-desktop.txt',notes:'modified by Nuwax'}]};
  write(path.join(outDir,'licenses/agent-desktop.txt'),license);write(path.join(outDir,'sources/ffmpeg.tar.xz'),archive);write(path.join(outDir,'third-party-notices.json'),document);
  return {document};
 };
 const result=prepareReleaseNotices(f.dir,{platform:'darwin',arch:'arm64',generate});
 assert.equal(result.document.components[0].sourceArchive,'capture/sources/ffmpeg.tar.xz');
 assert.equal(fs.existsSync(path.join(result.output,'sources/ffmpeg.tar.xz')),false);
 const pkg=JSON.parse(fs.readFileSync(path.join(client,'package.json')));
 assert.equal(pkg.build.extraResources.filter(e=>e.to==='third-party').length,1);
 const resources=path.join(f.dir,'packaged-resources'),thirdParty=path.join(resources,'third-party');
 fs.cpSync(result.output,thirdParty,{recursive:true});fs.cpSync(capture,path.join(thirdParty,'capture'),{recursive:true});
 assert.equal(verifyReleaseNotices(f.dir,resources,{platform:'darwin',arch:'arm64'}).components.length,2);
 fs.appendFileSync(path.join(thirdParty,'licenses/agent-desktop.txt'),'corrupt');
 assert.throws(()=>verifyReleaseNotices(f.dir,resources,{platform:'darwin',arch:'arm64'}),/Packaged notice differs/);
});
