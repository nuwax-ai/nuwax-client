import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from './client/core.mjs';
import { prepareDevelopmentApp } from './client/dev-app.mjs';

test('mac development owns its system identity without rewriting the Electron SDK', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-dev-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = core.paths(root);
  const sdk = path.join(p.client, 'node_modules/electron/dist/Electron.app');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write(path.join(sdk, 'Contents/MacOS/Electron'), 'original executable');
  write(path.join(sdk, 'Contents/Info.plist'), 'original identity');
  write(path.join(sdk, 'Contents/Resources/en.lproj/InfoPlist.strings'), 'Electron');
  const framework = 'Contents/Frameworks/Electron Framework.framework';
  for (const entry of ['Electron Framework', 'Versions/A/Electron Framework', 'Versions/Current/Electron Framework']) {
    write(path.join(sdk, framework, entry), 'framework binary');
  }
  const calls = [];
  const tools = { ...core, run: async (command, args) => { calls.push([command, args]); return { status: 0 }; } };
  const result = await prepareDevelopmentApp(root, { tools, platform: 'darwin' });
  assert.ok(result.bundle.endsWith('Nuwax Dev.app'));
  assert.equal(fs.readFileSync(path.join(sdk, 'Contents/Info.plist'), 'utf8'), 'original identity');
  assert.equal(fs.readFileSync(path.join(sdk, 'Contents/Resources/en.lproj/InfoPlist.strings'), 'utf8'), 'Electron');
  assert.ok(calls.some(([command, args]) => command.endsWith('PlistBuddy') && args.includes('Set :CFBundleIdentifier com.nuwax-ai.nuwax.dev')));
  assert.ok(calls.filter(([command]) => command.endsWith('PlistBuddy')).every(([, args]) => !args.includes(path.join(sdk, 'Contents/Info.plist'))));
  assert.match(fs.readFileSync(path.join(result.bundle, 'Contents/Resources/en.lproj/InfoPlist.strings'), 'utf8'), /Nuwax Dev/);
  assert.equal(fs.lstatSync(path.join(result.bundle, framework, 'Electron Framework')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(result.bundle, framework, 'Versions/Current')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(sdk, framework, 'Versions/Current')).isDirectory(), true);
  calls.length = 0;
  assert.deepEqual(await prepareDevelopmentApp(root, { tools, platform: 'darwin' }), result);
  assert.deepEqual(calls.map(([command]) => command), ['codesign'], 'warm launch verifies and reuses the same stable signed bundle');
});
