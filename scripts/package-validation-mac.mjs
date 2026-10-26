/** Signed, notarized private artifacts. No Release/storage/update-pointer APIs. */
import path from 'node:path';
import * as core from './client/core.mjs';
import { commercialEnv } from './client/prepare.mjs';
import { pack } from './client/pack.mjs';
import { prepareReleaseCapture, injectReleaseCapture, verifyReleaseCaptureOutput } from './prepare-release-capture.mjs';
import { notarizeSignedApp, packageNotarizedApp } from './release-mac-notarization.mjs';

export async function packSignedValidationMac(root, options, {
  tools = core, env = process.env, packFn = pack, captureFn = prepareReleaseCapture,
  notarizeFn = notarizeSignedApp, packageFn = packageNotarizedApp, verifyCaptureFn = verifyReleaseCaptureOutput,
} = {}) {
  if (options.platform !== 'darwin' || options.arch !== 'arm64') throw new Error('Private Mac acceptance requires native ARM64');
  for (const key of ['APPLE_SIGNING_IDENTITY', 'CSC_KEYCHAIN', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_ISSUER_ID']) {
    if (!env[key]) throw new Error(`Private Mac acceptance requires ${key}`);
  }
  // Reuse local preparation/branding/resource admission without weakening its
  // unsigned defaults. Only this private path performs the second signed pack.
  const built = await packFn(root, { ...options, dir: true });
  const client = tools.paths(root).client;
  const capture = await captureFn(root, { platform: 'darwin', arch: options.arch, macSigning: true,
    signIdentity: env.APPLE_SIGNING_IDENTITY, signKeychain: env.CSC_KEYCHAIN });
  const builder = injectReleaseCapture(tools.readJson(built.configFile), {
    ...capture, platform: 'darwin', arch: options.arch, macPreSigned: true,
  });
  builder.mac = { ...builder.mac, identity: env.APPLE_SIGNING_IDENTITY, hardenedRuntime: true, notarize: false };
  builder.dmg = { ...builder.dmg, artifactName: '${productName}-${version}-arm64.${ext}' };
  const helper = path.join(client, 'resources/computer-use/Nuwax Computer Use.app');
  await tools.run('codesign', ['--force', '--sign', env.APPLE_SIGNING_IDENTITY, '--keychain', env.CSC_KEYCHAIN,
    '--timestamp', '--options', 'runtime', helper], { capture: true });
  await tools.run('codesign', ['--verify', '--deep', '--strict', helper], { capture: true });
  tools.atomicJson(built.configFile, builder);
  const packageFile = path.join(client, 'package.json');
  const pkg = tools.readJson(packageFile);
  pkg.build = builder;
  tools.atomicJson(packageFile, pkg);
  const signingEnv = commercialEnv(root, { ...env, CSC_NAME: env.APPLE_SIGNING_IDENTITY,
    SKIP_PREPARE: '1', SKIP_WINDOWS_AFTER_SIGN: '1', ELECTRON_BUILDER_COMPRESSION_LEVEL: '1',
    APPLE_API_KEY: '', APPLE_API_KEY_ID: '', APPLE_ISSUER_ID: '' });
  await tools.pnpmRun(client, ['exec', 'electron-builder', '--config', built.configFile,
    '--mac', '--arm64', '--dir', '--publish', 'never'], { env: signingEnv });
  const app = path.join(options.output, 'mac-arm64/Nuwax.app');
  await notarizeFn({ app, stateFile: path.join(options.output, 'mac-arm64/.nuwax-notary.json'),
    auth: { key: env.APPLE_API_KEY, keyId: env.APPLE_API_KEY_ID, issuer: env.APPLE_ISSUER_ID } });
  await packageFn({ client, app, arch: options.arch, configFile: built.configFile, tools: {
    ...tools, run: (command, args, opts) => tools.run(command, args, { ...opts, env: signingEnv }),
  } });
  await verifyCaptureFn(root, options.output, { platform: 'darwin', arch: options.arch });
  await tools.run('spctl', ['--assess', '--type', 'execute', '--verbose', app], { capture: true });
  const verified = await tools.run('codesign', ['-d', '--verbose=4', app], { capture: true });
  const text = `${verified.stdout}\n${verified.stderr}`;
  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(text)?.[1];
  if (!team || /Signature=adhoc/.test(text)) throw new Error('Private acceptance app has no Developer ID identity');
  return { ...built, validationSigning: { signed: true, notarized: true, team } };
}
