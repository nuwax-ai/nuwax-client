import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as core from './core.mjs';
import { electronBinary, inputDigest } from './prepare.mjs';

export const DEV_APP_NAME = 'Nuwax Dev';
export const DEV_APP_ID = 'com.nuwax-ai.nuwax.dev';

/** Some extracted SDKs flatten framework symlinks; normalize only identical private copies. */
function normalizeFrameworks(bundle) {
  const frameworks = path.join(bundle, 'Contents/Frameworks');
  if (!fs.existsSync(frameworks)) return;
  for (const name of fs.readdirSync(frameworks).filter(name => name.endsWith('.framework'))) {
    const framework = path.join(frameworks, name), version = path.join(framework, 'Versions/A');
    if (!fs.existsSync(version)) continue;
    const links = [['Versions/Current', 'A', version], ...fs.readdirSync(version).map(entry => [entry, `Versions/Current/${entry}`, path.join(version, entry)])];
    for (const [entry, target, canonical] of links) {
      const duplicate = path.join(framework, entry);
      if (fs.existsSync(duplicate) && !fs.lstatSync(duplicate).isSymbolicLink()) {
        if (inputDigest([duplicate]) !== inputDigest([canonical])) throw new Error(`[dev] Framework copies disagree: ${name}/${entry}`);
        fs.rmSync(duplicate, { recursive: true, force: true });
      }
      if (!fs.existsSync(duplicate)) fs.symlinkSync(target, duplicate);
    }
  }
}

/** Own a stable dev bundle so macOS permissions never use the generic Electron identity. */
export async function prepareDevelopmentApp(root, { tools = core, platform = process.platform } = {}) {
  const p = tools.paths(root);
  const originalBinary = electronBinary(p.client, platform);
  if (platform !== 'darwin') return { binary: originalBinary, bundle: null };
  const source = path.resolve(originalBinary, '../../..');
  const bundle = path.join(p.cache, 'dev', `${DEV_APP_NAME}.app`);
  const binary = path.join(bundle, 'Contents/MacOS/Electron');
  const stateFile = path.join(p.cache, 'dev-app.json');
  const stat = fs.statSync(originalBinary);
  const key = tools.fingerprint([stat.size, stat.mtimeMs, tools.fileHash(path.join(source, 'Contents/Info.plist')),
    tools.fileHash(fileURLToPath(import.meta.url))]);
  let saved;
  try { saved = tools.readJson(stateFile); } catch { /* First launch. */ }
  if (saved?.key === key && fs.existsSync(binary)) {
    await tools.run('codesign', ['--verify', '--deep', '--strict', bundle], { capture: true });
    return { binary, bundle };
  }
  const staged = `${bundle}.stage-${randomUUID()}.app`;
  try {
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.cpSync(source, staged, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    normalizeFrameworks(staged);
    const plist = path.join(staged, 'Contents/Info.plist');
    for (const [name, value] of Object.entries({ CFBundleIdentifier: DEV_APP_ID, CFBundleName: DEV_APP_NAME, CFBundleDisplayName: DEV_APP_NAME })) {
      const result = await tools.run('/usr/libexec/PlistBuddy', ['-c', `Set :${name} ${value}`, plist], { capture: true, allowFailure: true });
      if (result.status !== 0) await tools.run('/usr/libexec/PlistBuddy', ['-c', `Add :${name} string ${value}`, plist], { capture: true });
    }
    const resources = path.join(staged, 'Contents/Resources');
    for (const locale of new Set(['en.lproj', ...fs.readdirSync(resources).filter(name => name.endsWith('.lproj'))])) {
      fs.mkdirSync(path.join(resources, locale), { recursive: true });
      fs.writeFileSync(path.join(resources, locale, 'InfoPlist.strings'), `"CFBundleName" = "${DEV_APP_NAME}";\n"CFBundleDisplayName" = "${DEV_APP_NAME}";\n`);
    }
    await tools.run('codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', staged], { capture: true });
    await tools.run('codesign', ['--verify', '--deep', '--strict', staged], { capture: true });
    // The managed dev runner has exited before replacing its private app copy.
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(staged, bundle);
    tools.atomicJson(stateFile, { key });
    return { binary, bundle };
  } finally { fs.rmSync(staged, { recursive: true, force: true }); }
}
