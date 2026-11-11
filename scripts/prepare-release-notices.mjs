#!/usr/bin/env node
/** Complete application notices are prepared before signing, separately from
 * the capture cache recipe, and verified read-only against packaged resources. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from './client/core.mjs';
import { generateThirdPartyNotices } from './client/source-notices.mjs';
import { shippedResourcePaths } from './client/third-party-notices.mjs';
import { packagedResources } from './prepare-release-updater.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const releaseNoticesDirectory = (root, platform, arch) => path.join(core.paths(root).cache,'release-notices',platform+'-'+arch);
export function prepareReleaseNotices(root, {
  platform=process.platform, arch=process.arch, generate=generateThirdPartyNotices,
}={}) {
  const client=core.paths(root).client, filename=path.join(client,'package.json');
  const pkg=JSON.parse(fs.readFileSync(filename));
  const output=releaseNoticesDirectory(root,platform,arch);
  fs.rmSync(output,{recursive:true,force:true});
  const resourcePaths=shippedResourcePaths(pkg.build,client,platform);
  // Signed capture is staged outside resources/; its builder destination is
  // authoritative, otherwise the complete manifest would omit this binary.
  const encoder=(pkg.build.extraResources??[]).find(e=>typeof e==='object'&&e.to===`capture/${platform}-${arch}`);
  if (encoder) resourcePaths.capture=path.resolve(client,encoder.from);
  const result=generate(root,{strict:true,outDir:output,
    resourcePaths,platform,arch});
  const capture=(pkg.build.extraResources??[]).find(e=>typeof e==='object'&&e.to==='third-party/capture');
  if (capture) {
    // Legacy capture admission verifies this directory. Reference its already
    // shipped archives instead of packing FFmpeg sources a second time.
    for (const component of result.document.components) {
      if (component.usedBy!=='capture'||!component.sourceArchive) continue;
      const archive=component.sourceArchive;
      if (!/^sources\/[A-Za-z0-9._-]+$/.test(archive)) throw new Error('[release-notices] Unsafe capture source reference');
      const original=path.resolve(client,capture.from,archive);
      if (!fs.lstatSync(original).isFile()||hash(original)!==component.sourceSha256) throw new Error('[release-notices] Capture archive differs from declaration');
      component.sourceArchive='capture/'+archive;
      if (!result.document.components.some(c=>c!==component&&c.sourceArchive===archive)) fs.rmSync(path.join(output,archive),{force:true});
    }
    fs.writeFileSync(path.join(output,'third-party-notices.json'),JSON.stringify(result.document,null,2)+'\n');
  }
  pkg.build.extraResources=(pkg.build.extraResources??[]).filter(e=>typeof e!=='object'||e.to!=='third-party');
  pkg.build.extraResources.push({from:output,to:'third-party',filter:['third-party-notices.json','licenses/**','sources/**']});
  core.atomicJson(filename,pkg);
  console.log('[release-notices] Prepared '+result.document.components.length+' complete application notices');
  return {output,document:result.document};
}
export function verifyReleaseNotices(root, resources, {platform=process.platform,arch=process.arch}={}) {
  const expected=releaseNoticesDirectory(root,platform,arch);
  const packaged=path.join(resources,'third-party');
  function verifyTree(directory, relative='') {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name), name=path.join(relative,entry.name);
      if (entry.isDirectory()) {verifyTree(file,name);continue;}
      const target=path.join(packaged,name);
      if (!entry.isFile()||!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink()||hash(file)!==hash(target))
        throw new Error('[release-notices] Packaged notice differs: '+name);
    }
  }
  verifyTree(expected);
  const document=JSON.parse(fs.readFileSync(path.join(packaged,'third-party-notices.json')));
  for (const item of document.components) if (item.sourceArchive) {
    if (!/^(?:capture\/)?sources\/[A-Za-z0-9._-]+$/.test(item.sourceArchive)) throw new Error('[release-notices] Unsafe source archive path');
    const archive=path.join(packaged,item.sourceArchive);
    if (!fs.lstatSync(archive).isFile()||hash(archive)!==item.sourceSha256) throw new Error('[release-notices] Packaged source archive differs: '+item.id);
  }
  console.log('[release-notices] Verified complete packaged notice manifest, licenses and source archives');
  return document;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
    const arch=option('--arch',process.arch), output=option('--verify-output');
    if (output) verifyReleaseNotices(root,packagedResources(output,process.platform,arch),{arch});
    else prepareReleaseNotices(root,{arch});
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
