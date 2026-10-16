#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../client.config.mjs';
import * as core from './client/core.mjs';
import { configureSystemAppName } from './client/system-app-name.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export function prepareReleaseSystemName(client, options = {}) {
  const file = path.join(client, 'package.json');
  const pkg = core.readJson(file);
  if (pkg.build?.appId !== config.product.appId || pkg.build?.extraMetadata?.name !== config.product.identifier) {
    throw new Error('[branding] Commercial application identity is required');
  }
  pkg.build = configureSystemAppName(pkg.build, options);
  pkg.productName = pkg.build.productName;
  core.atomicJson(file, pkg);
}

export async function verifyMacSystemName(app, tools = core) {
  const source = `ObjC.import('Foundation');function run(args){const b=$.NSBundle.bundleWithPath(args[0]);return JSON.stringify({fileName:ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(args[0])),bundleName:ObjC.unwrap(b.objectForInfoDictionaryKey('CFBundleName')),displayName:ObjC.unwrap(b.objectForInfoDictionaryKey('CFBundleDisplayName'))});}`;
  // CI runners use English. Verify the actual Finder lookup under Chinese
  // preferences too; NSBundle's localized keys alone missed the empty locales.
  const preferences = [null, '(en-US)', '(zh-Hans-CN,en-CN,zh-Hant-HK)', '(zh-Hant-TW,en-US)', '(zh-Hant-HK,en-US)'];
  let systemNames;
  for (const languages of preferences) {
    const result = await tools.run('osascript', ['-l', 'JavaScript', '-e', source, app,
      ...(languages ? ['-AppleLanguages', languages] : [])], { capture: true });
    const names = JSON.parse(result.stdout);
    if (names.fileName?.replace(/\.app$/, '') !== config.product.displayName ||
        names.bundleName !== config.product.displayName || names.displayName !== config.product.displayName) {
      throw new Error(`[branding] Incorrect native macOS application name (${languages ?? 'system'}): ${JSON.stringify(names)}`);
    }
    if (!languages) systemNames = names;
  }
  console.log(`[branding] Native macOS application name verified in system, English and Chinese locales: ${config.product.displayName}`);
  return systemNames;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
      const index = args.indexOf(name);
      if (index < 0) return fallback;
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
      return args[index + 1];
    };
    const app = option('--verify-app');
    if (app) await verifyMacSystemName(path.resolve(app));
    else {
      prepareReleaseSystemName(path.resolve(option('--client', core.paths(root).client)), {
        platform: option('--platform', process.platform), arch: option('--arch', process.env.TARGET_ARCH || process.arch),
      });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
