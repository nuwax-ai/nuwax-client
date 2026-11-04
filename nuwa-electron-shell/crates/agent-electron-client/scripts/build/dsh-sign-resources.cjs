const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nativeTargets } = require('./dsh-sign-targets.cjs');
/** Run before Electron seals the application; libraries may lack execute bits. */
async function signDshResources({ resources, identity, keychain }) {
  if (!identity) throw new Error('DSH resource signing requires the resolved application identity');
  const entitlements = path.resolve(__dirname, '../../build/entitlements.child.plist');
  for (const name of ['dsh-runtime', 'dsh-office']) {
    const root = path.join(resources, name);
    if (!fs.existsSync(root)) continue;
    const targets = nativeTargets(root);
    for (const file of targets) {
      const args = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime'];
      if (keychain) args.push('--keychain', keychain);
      if (/^(node|python[0-9.]*)$/.test(path.basename(file))) args.push('--entitlements', entitlements);
      execFileSync('codesign', [...args, file], { stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('codesign', ['--verify', '--strict', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    console.log(`[dsh] Signed ${targets.length} native files in ${name}`);
  }
}
module.exports = { signDshResources };
