import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

test('file-server install and build consume the disposable source outside the workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-server build-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, 'workspace', 'client');
  const source = path.join(client, '.cache', 'bundled-sources', 'nuwax-file-server');
  const copy = path.join(root, 'temporary source');
  const destination = path.join(client, 'resources', 'nuwax-file-server');
  const url = 'https://github.com/nuwax-ai/nuwax-file-server.git';
  const commit = 'a'.repeat(40);
  const hash = 'b'.repeat(64);
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write(path.join(client, 'package.json'), { bundledSources: { 'nuwax-file-server': { url, branch: 'main' } } });
  write(path.join(source, 'package.json'), {
    name: 'file-server-build-fixture', version: '1.0.0', private: true,
    scripts: { build: 'node build.cjs' },
  });
  write(path.join(source, 'build.cjs'), "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.mkdirSync('node_modules',{recursive:true});fs.copyFileSync('input.txt','dist/server.js');");
  write(path.join(source, 'input.txt'), 'original source');
  write(path.join(source, 'node_modules', 'keep.txt'), 'existing source dependency');
  fs.mkdirSync(path.join(source, '.git'));
  const script = fileURLToPath(new URL('../nuwa-electron-shell/crates/agent-electron-client/scripts/prepare/prepare-nuwax-file-server.js', import.meta.url));
  const realRequire = createRequire(script);
  const npmCalls = [];
  let disposed = false;
  const require = (name) => {
    if (name === '../utils/project-paths') return { getProjectRoot: () => client };
    if (path.basename(name) === 'source-patches.cjs') return {
      fileServerPatch: () => ({ file: 'fixture.patch', hash }),
      createPatchedSource(directory) {
        assert.equal(directory, source);
        fs.cpSync(source, copy, { recursive: true, filter: (file) => !['.git', 'node_modules'].includes(path.basename(file)) });
        write(path.join(copy, 'input.txt'), 'patched source');
        return { directory: copy, dispose() { disposed = true; fs.rmSync(copy, { recursive: true, force: true }); } };
      },
    };
    if (name === 'child_process') return {
      execSync(command, options) {
        if (command.startsWith('git ')) {
          if (command === 'git remote get-url origin') return url;
          return command.startsWith('git rev-parse ') ? commit : '';
        }
        assert.equal(options.cwd, copy, 'npm must run in the source copy even when its drive differs from the workspace');
        npmCalls.push(command);
        return execSync(command, {
          ...options, stdio: 'pipe', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
        });
      },
    };
    return realRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), { require, __dirname: path.dirname(script), console: { log() {} } }, { filename: script });
  assert.deepEqual(npmCalls, ['npm install --ignore-scripts', 'npm run build']);
  assert.equal(fs.readFileSync(path.join(destination, 'dist/server.js'), 'utf8'), 'patched source');
  assert.equal(fs.readFileSync(path.join(destination, '.commit-hash'), 'utf8').trim(), commit);
  assert.equal(fs.readFileSync(path.join(destination, '.source-patch-sha256'), 'utf8').trim(), hash);
  assert.equal(fs.readFileSync(path.join(source, 'input.txt'), 'utf8'), 'original source');
  assert.equal(fs.readFileSync(path.join(source, 'node_modules/keep.txt'), 'utf8'), 'existing source dependency');
  assert.equal(disposed, true);
});
