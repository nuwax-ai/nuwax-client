import assert from 'node:assert/strict';
import test from 'node:test';
import { packSignedValidationMac } from './package-validation-mac.mjs';

for (const arch of ['arm64', 'x64']) test(`private ${arch} Mac build signs helper and admitted capture before notarization; never publishes`, async () => {
  const calls = [];
  const pkg = { build: {} }, config = { mac: {}, extraResources: [] };
  const env = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: fixture', CSC_KEYCHAIN: '/private/keychain',
    APPLE_API_KEY: '/private/key.p8', APPLE_API_KEY_ID: 'KEY', APPLE_ISSUER_ID: 'ISSUER' };
  const tools = {
    paths: () => ({ client: '/client' }), readJson: file => file.endsWith('package.json') ? pkg : config,
    atomicJson: (file, value) => calls.push(['write', file, value]),
    run: async (cmd, args, opts) => { calls.push([cmd, args, opts]); return { status: 0, stdout: '', stderr: 'TeamIdentifier=TEAM123\n' }; },
    pnpmRun: async (_client, args, options) => { calls.push(['builder', args, options]); },
  };
  const result = await packSignedValidationMac('/root', { platform: 'darwin', arch, output: '/output' }, {
    tools, env,
    packFn: async (_root, opts) => { assert.equal(opts.dir, true); return { configFile: '/isolated-config.json' }; },
    captureFn: async (_root, opts) => { assert.equal(opts.macSigning, true); calls.push(['capture']); return { captureDir: '/signed-capture', noticesDir: '/notices' }; },
    notarizeFn: async opts => { calls.push(['notarize']); assert.equal(opts.app, `/output/${arch === 'arm64' ? 'mac-arm64' : 'mac'}/Nuwax.app`); },
    packageFn: async opts => {
      calls.push(['package']); assert.equal(opts.configFile, '/isolated-config.json');
      assert.equal(opts.env.APPLE_API_KEY, '');
      await opts.tools.run('fixture-builder', [], { env: { PATH: '/scoped/dmg-tools:/usr/bin', NUWAX_DMG_ARCH: arch } });
      const forwarded = calls.find(call => call[0] === 'fixture-builder')[2].env;
      assert.equal(forwarded.PATH, '/scoped/dmg-tools:/usr/bin');
      assert.equal(forwarded.APPLE_API_KEY, '');
      assert.equal(forwarded.CSC_NAME, env.APPLE_SIGNING_IDENTITY);
    },
    verifyCaptureFn: async () => calls.push(['verify-capture']),
    verifyPayloadFn: async (output, options) => {
      assert.equal(output, '/output');
      assert.deepEqual(options, { platform: 'darwin', arch });
      calls.push(['verify-payload']);
    },
  });
  const builder = calls.find(c => c[0] === 'builder');
  assert.ok(builder[1].includes('--publish')); assert.ok(builder[1].includes('never'));
  assert.ok(builder[1].includes(`--${arch}`));
  assert.equal(builder[2].env.APPLE_API_KEY, '');
  assert.equal(pkg.build.mac.hardenedRuntime, true); assert.equal(pkg.build.mac.notarize, false);
  assert.ok(calls.findIndex(c => c[0] === 'capture') < calls.findIndex(c => c[0] === 'builder'));
  assert.ok(calls.findIndex(c => c[0] === 'notarize') < calls.findIndex(c => c[0] === 'package'));
  assert.ok(calls.findIndex(c => c[0] === 'package') < calls.findIndex(c => c[0] === 'verify-payload'));
  assert.ok(calls.findIndex(c => c[0] === 'verify-payload') < calls.findIndex(c => c[0] === 'spctl'));
  assert.deepEqual(result.validationSigning, { signed: true, notarized: true, team: 'TEAM123' });
});

test('missing private signing credentials stop before package compilation', async () => {
  await assert.rejects(packSignedValidationMac('/root', { platform: 'darwin', arch: 'arm64' }, {
    env: {}, packFn: async () => { throw new Error('must not build'); },
  }), /requires APPLE_SIGNING_IDENTITY/);
});
