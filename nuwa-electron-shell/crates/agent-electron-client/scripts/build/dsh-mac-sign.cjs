const path = require('node:path');
const { createRequire } = require('node:module');
const { signDshResources } = require('./dsh-sign-resources.cjs');
const MAX_BINARY_PROBES = 24;

/** osx-sign 1.3.1 starts a binary probe for every file concurrently. Bound only
 * those probes; preserve electron-builder's signer, retries and verification. */
async function withLimitedBinaryProbes(binary, operation, limit = MAX_BINARY_PROBES) {
  const original = binary.isBinaryFile;
  const waiting = [], drained = [];
  let active = 0;
  const acquire = async () => {
    if (active < limit) { active++; return; }
    await new Promise(resolve => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else if (--active === 0) drained.splice(0).forEach(resolve => resolve());
  };
  binary.isBinaryFile = async (...args) => {
    await acquire();
    try { return await original.apply(binary, args); } finally { release(); }
  };
  try { return await operation(); }
  finally {
    if (active) await new Promise(resolve => drained.push(resolve));
    binary.isBinaryFile = original;
  }
}

function createMacSigner({ sign, binary, signResources = signDshResources }) {
  // Multiple app bundles share the dependency module; serialize its temporary hook.
  let queue = Promise.resolve();
  return options => {
    const next = queue.then(async () => {
      const resources = path.join(options.app, 'Contents/Resources');
      await signResources({ resources, identity: options.identity, keychain: options.keychain });
      const prior = options.ignore === undefined ? [] : [].concat(options.ignore);
      const ignore = file => {
        const owned = path.relative(resources, file).split(path.sep)[0];
        return owned === 'dsh-runtime' || owned === 'dsh-office' || prior.some(rule =>
          typeof rule === 'function' ? rule(file) : String(file).match(rule) !== null);
      };
      // Owned native files already carry the same identity and interpreter JIT
      // entitlements. The outer signer still seals their resources with the app.
      return withLimitedBinaryProbes(binary, () => sign({ ...options, ignore }));
    });
    queue = next.catch(() => {});
    return next;
  };
}

let signer;
module.exports = options => {
  if (!signer) {
    const builder = createRequire(require.resolve('electron-builder'));
    const appBuilder = createRequire(builder.resolve('app-builder-lib'));
    const osx = createRequire(appBuilder.resolve('@electron/osx-sign'));
    // This is the exact default adapter of the pinned electron-builder 25.1.8.
    signer = createMacSigner({ sign: appBuilder('./codeSign/macCodeSign.js').sign, binary: osx('isbinaryfile') });
  }
  return signer(options);
};
Object.assign(module.exports, { createMacSigner, withLimitedBinaryProbes, MAX_BINARY_PROBES });
