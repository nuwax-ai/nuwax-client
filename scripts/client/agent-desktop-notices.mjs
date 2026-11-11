/** Packaging-only expansion of the audited Agent Desktop binary dependency set. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AGENT_DESKTOP_VERSION, AGENT_DESKTOP_INTEGRITY } from './agent-desktop-resources.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeFile = /^third-party\/agent-desktop\/(?:inventory\.json|licenses\/[A-Za-z0-9._-]+\.txt)$/;
const allowed = new Set(['MIT','Apache-2.0','LLVM-exception','Unicode-3.0','0BSD','Zlib','Unlicense','OR','AND','WITH']);
function evidence(root, name, expected) {
  if (!safeFile.test(name) || !/^[a-f0-9]{64}$/.test(expected??'')) throw new Error('[agent-desktop-notices] Invalid evidence identity');
  let file=root;
  for (const part of name.split('/')) {
    file=path.join(file,part);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('[agent-desktop-notices] Linked evidence refused');
  }
  const bytes=fs.readFileSync(file);
  if (bytes.length>1024*1024 || digest(bytes)!==expected) throw new Error('[agent-desktop-notices] Evidence SHA256 mismatch: '+name);
  return bytes;
}
export function expandAgentDesktopNotices(root, entry, { platform=process.platform, arch=process.arch, resourcePath }={}) {
  if (!entry.licenseInventory) return entry;
  const inventory=JSON.parse(evidence(root,entry.licenseInventory,entry.licenseInventorySha256));
  const target=platform+'-'+arch;
  if (inventory.schema!==1 || inventory.version!==entry.version || inventory.version!==AGENT_DESKTOP_VERSION ||
      inventory.integrity!==AGENT_DESKTOP_INTEGRITY || !/^[a-f0-9]{40}$/.test(inventory.revision??'') ||
      !/^[a-f0-9]{64}$/.test(inventory.cargoLockSha256??'') ||
      !Array.isArray(inventory.targets) || !inventory.targets.includes(target) ||
      !Array.isArray(inventory.components) || !Array.isArray(inventory.runtimes)) throw new Error('[agent-desktop-notices] Stale dependency inventory');
  const file=path.join(resourcePath??'',target,'source.json');
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('[agent-desktop-notices] Missing resource identity');
  const source=JSON.parse(fs.readFileSync(file));
  if (source.version!==inventory.version || source.integrity!==inventory.integrity ||
      platform==='win32' && source.nativeBuild?.revision!==inventory.revision) throw new Error('[agent-desktop-notices] Payload differs from audited source');
  if (platform==='win32' && !inventory.runtimes.some(runtime=>runtime.targets?.includes(target)&&runtime.version===source.nativeBuild?.toolchain))
    throw new Error('[agent-desktop-notices] Missing native toolchain attribution');
  const ids=new Set([entry.id]), components=[];
  for (const item of [...inventory.components,...inventory.runtimes]) {
    if (typeof item.id!=='string' || !/^[A-Za-z0-9._-]+$/.test(item.id) || ids.has(item.id) ||
        !Array.isArray(item.targets) || typeof item.license!=='string' ||
        !item.license.match(/[A-Za-z0-9.-]+/g)?.every(token=>allowed.has(token)) ||
        !item.sourceUrl?.startsWith('https://')) throw new Error('[agent-desktop-notices] Unreviewed dependency record');
    ids.add(item.id);
    // Audit every record's license even when it belongs to another target, so
    // a damaged checked-in inventory cannot silently become a platform blind spot.
    evidence(root,item.licenseFile,item.licenseSha256);
    if (item.targets.includes(target)) components.push(item);
  }
  const modified=platform==='win32';
  const notes=modified
    ? 'Nuwax 修改说明：基于上游 '+inventory.revision+'，修改 crates/windows/src/tree/automation.rs，关闭 UI Automation 隐式焦点切换；补丁 third-party/patches/agent-desktop-windows-no-focus.patch。'
    : '采用上游 '+inventory.version+' 的原生发行二进制，未修改该平台的 Agent Desktop 源码。';
  return {...entry,modified,notes,components:[...(entry.components??[]),...components]};
}
