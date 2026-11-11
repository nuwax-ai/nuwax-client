#!/usr/bin/env node
/** Refresh the audited license inventory from the exact upstream Cargo.lock.
 * This is an explicit maintainer operation, never a network step in packaging. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_DESKTOP_VERSION, AGENT_DESKTOP_INTEGRITY } from './client/agent-desktop-resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const revision = '2b0a7334fc111730454b726e6800aa41cdafc093';
const targets = {
  'darwin-arm64': ['aarch64-apple-darwin', 'agent-desktop-macos'],
  'darwin-x64': ['x86_64-apple-darwin', 'agent-desktop-macos'],
  'win32-x64': ['x86_64-pc-windows-msvc'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'agent-desktop-linux'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', 'agent-desktop-linux'],
};
const upstream = {
  'accessibility-sys@0.2.0': ['https://raw.githubusercontent.com/eiz/accessibility/63a4a9c4ecdc143bed1d65b989aa18bbc5fd8129/LICENSE-MIT',
    'https://raw.githubusercontent.com/eiz/accessibility/63a4a9c4ecdc143bed1d65b989aa18bbc5fd8129/LICENSE-APACHE'],
  'uiautomation@0.25.0': ['https://raw.githubusercontent.com/leexgone/uiautomation-rs/0f10aed0f4be6a7cc9099b16cddcc502fc5e5dec/LICENSE'],
  'uiautomation_derive@0.7.8': ['https://raw.githubusercontent.com/leexgone/uiautomation-rs/0f10aed0f4be6a7cc9099b16cddcc502fc5e5dec/LICENSE'],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).split(path.sep).join('/');
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
}
function licenseFiles(directory, licenseFile) {
  const found = [];
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isFile()) found.push(file);
      else if (entry.isDirectory()) visit(file);
      else throw new Error('Linked license evidence is not admitted');
    }
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/^(licen[sc]e|copying|copyright|notice)([-_.]|$)/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isFile()) found.push(file);
    else if (entry.isDirectory()) visit(file);
  }
  if (licenseFile) {
    const file = path.resolve(directory, licenseFile);
    if (path.relative(directory, file).startsWith('..') || !fs.lstatSync(file).isFile()) throw new Error('Unsafe license-file');
    found.push(file);
  }
  return [...new Set(found)].sort();
}
function closure(metadata, roots) {
  const packages = new Map(metadata.packages.map(p=>[p.id,p]));
  const nodes = new Map(metadata.resolve.nodes.map(n=>[n.id,n]));
  const queue = metadata.packages.filter(p=>!p.source && roots.includes(p.name)).map(p=>p.id), seen = new Set();
  if (queue.length !== roots.length) throw new Error('Missing shipped executable roots');
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some(kind=>kind.kind!=='dev')) queue.push(dep.pkg);
  }
  return [...seen].map(id=>packages.get(id)).filter(p=>p.source);
}
async function generate(source, output) {
  if (run('git',['rev-parse','HEAD'],source).trim() !== revision || run('git',['status','--porcelain','--untracked-files=no'],source).trim()) throw new Error('Require the unchanged pinned upstream checkout');
  const lock = fs.readFileSync(path.join(source,'Cargo.lock'));
  const locked = JSON.parse(run('python3',['-c','import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))["package"]))',path.join(source,'Cargo.lock')],root));
  const union = new Map();
  for (const [target,[triple,helper]] of Object.entries(targets)) {
    const data = JSON.parse(run('cargo',['metadata','--locked','--offline','--format-version','1','--filter-platform',triple],source));
    for (const pkg of closure(data,['agent-desktop',...(helper?[helper]:[])])) {
      const key = pkg.name+'@'+pkg.version, old = union.get(key);
      if (old) old.targets.push(target); else union.set(key,{pkg,targets:[target]});
    }
  }
  fs.mkdirSync(path.join(output,'licenses'),{recursive:true});
  const components=[];
  for (const [key,{pkg,targets}] of [...union].sort(([a],[b])=>a.localeCompare(b))) {
    if (!pkg.source.startsWith('registry+https://github.com/rust-lang/crates.io-index') || !pkg.license) throw new Error('Unreviewed crate source/license: '+key);
    const directory = path.dirname(pkg.manifest_path);
    const record = locked.find(p=>p.name===pkg.name && p.version===pkg.version && p.source===pkg.source);
    const registry = path.dirname(path.dirname(path.dirname(directory)));
    const archive = path.join(registry,'cache',path.basename(path.dirname(directory)),pkg.name+'-'+pkg.version+'.crate');
    if (!record?.checksum || sha(fs.readFileSync(archive))!==record.checksum) throw new Error('Crate archive differs from Cargo.lock: '+key);
    const evidence = [];
    const sourceUrl = 'https://crates.io/api/v1/crates/'+pkg.name+'/'+pkg.version+'/download';
    for (const file of licenseFiles(directory,pkg.license_file)) {
      const bytes=fs.readFileSync(file);
      if (bytes.length>1024*1024) throw new Error('License evidence too large');
      evidence.push({name:path.relative(directory,file).split(path.sep).join('/'),url:sourceUrl,sha256:sha(bytes),text:bytes.toString('utf8')});
    }
    if (!evidence.length) for (const url of upstream[key]??[]) {
      const response = await fetch(url,{signal:AbortSignal.timeout(30_000)});
      if (!response.ok) throw new Error('Upstream license unavailable: '+url);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length>1024*1024 || !/Permission is hereby granted|Apache License/.test(bytes.toString())) throw new Error('Unexpected upstream license');
      evidence.push({name:new URL(url).pathname.split('/').pop(),url,sha256:sha(bytes),text:bytes.toString('utf8')});
    }
    if (!evidence.length) throw new Error('No license/attribution evidence: '+key);
    const license=pkg.license.replace(/\s*\/\s*/g,' OR ');
    const authors=pkg.authors.map(a=>a.replace(/\s*<[^>]*>/g,'')).join(', ');
    const text=('Agent Desktop dependency: '+key+'\nLicense expression: '+license+'\nAuthors (Cargo metadata):'+(authors?' '+authors:'')+'\nSource: '+sourceUrl+'\nSource archive SHA256: '+record.checksum+'\n\n'+evidence.map(e=>'===== '+e.name+' =====\nSource: '+e.url+'\n\n'+e.text.trimEnd()+'\n').join('\n')).replace(/\r\n/g,'\n');
    const id=('agent-desktop-crate-'+pkg.name+'-'+pkg.version).replace(/[^A-Za-z0-9._-]/g,'_');
    const licenseFile=path.join(output,'licenses',id+'.txt');
    fs.writeFileSync(licenseFile,text);
    components.push({id,name:pkg.name+' (Agent Desktop)',version:pkg.version,targets,license,
      licenseFile:relative(licenseFile),licenseSha256:sha(text),sourceUrl,sourceSha256:record.checksum,
      modified:false,checkIntegrity:true,usedBy:'computer-use',
      notes:'Agent Desktop 的静态 Rust 依赖；按固定 Cargo.lock 及目标平台登记，保留原始许可与归属声明。',
      evidence:evidence.map(({text,...rest})=>rest)});
  }
  const previous=path.join(output,'inventory.json');
  const runtimes=fs.existsSync(previous)?JSON.parse(fs.readFileSync(previous)).runtimes??[]:[];
  const inventory={schema:1,version:AGENT_DESKTOP_VERSION,revision,integrity:AGENT_DESKTOP_INTEGRITY,
    cargoLockSha256:sha(lock),targets:Object.keys(targets),components,runtimes};
  fs.writeFileSync(previous,JSON.stringify(inventory,null,2)+'\n');
  const manifestFile=path.join(root,'third-party/source-components.json');
  const manifest=JSON.parse(fs.readFileSync(manifestFile));
  manifest.components['agent-desktop'].licenseInventory=relative(previous);
  manifest.components['agent-desktop'].licenseInventorySha256=sha(fs.readFileSync(previous));
  fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  console.log('Audited '+components.length+' locked native dependencies across '+inventory.targets.length+' targets');
}
const sourceIndex=process.argv.indexOf('--source'), outputIndex=process.argv.indexOf('--out');
if (sourceIndex<0 || !process.argv[sourceIndex+1]) throw new Error('Usage: node scripts/generate-agent-desktop-notices.mjs --source PINNED_CHECKOUT [--out DIRECTORY]; fetch locked crates first. Rust runtime notices are maintained alongside this inventory.');
await generate(path.resolve(process.argv[sourceIndex+1]),outputIndex<0?path.join(root,'third-party/agent-desktop'):path.resolve(process.argv[outputIndex+1]));
