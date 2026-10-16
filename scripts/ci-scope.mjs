import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const testFiles = () => fs.readdirSync(path.join(root, 'scripts')).filter(f => f.endsWith('.test.mjs')).map(f => `scripts/${f}`).sort();
const flags = ['community', 'commercial', 'frontend', 'terminal', 'host_bridge', 'compatibility'];

function dependencies(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  if (!/\.[cm]?[jt]sx?$/.test(file)) return seen;
  let source;
  try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { return seen; }
  const imports = ts.preProcessFile(source, true, true).importedFiles.map(f => f.fileName);
  for (const match of source.matchAll(/new URL\(['"]([^'"]+)['"],\s*import\.meta\.url\)/g)) imports.push(match[1]);
  for (const name of imports) if (name.startsWith('.')) dependencies(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)), seen);
  return seen;
}

export function commentOnly(file, before, after) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || before == null || after == null) return false;
  // 编译、类型检查和打包注解也会改变行为，不能因它们写在注释中而跳过。
  if (/(?:\/[/\*]|\*)[^\r\n]*@|#__|webpack(?:Ignore|ChunkName|Mode|Prefetch|Preload)|(?:istanbul|c8|v8) ignore|(?:eslint|prettier)-(?:ignore|disable|enable)|source(?:Mapping)?URL|^\s*\/\/\//m.test(before + after)) return false;
  const kind = /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const parse = source => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const a = parse(before), b = parse(after);
  if (a.parseDiagnostics.length || b.parseDiagnostics.length) return false;
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printFile(a) === printer.printFile(b);
}

export function selectChecks(files, { full = false, tests = testFiles() } = {}) {
  const result = Object.fromEntries(flags.map(k => [k, false]));
  let allScripts = false;
  const selected = new Set();
  const graph = new Map(tests.map(f => [f, dependencies(f)]));
  const all = () => { for (const k of flags) result[k] = true; allScripts = true; };
  const scripts = file => {
    const affected = tests.filter(f => graph.get(f).has(file));
    if (affected.length) affected.forEach(f => selected.add(f));
    else allScripts = true;
  };
  if (full) all();
  for (const file of files) {
    if (/^(?:docs|plans|specs|release-notes|templates)\//.test(file) || /\.(md|mdx|rst)$/.test(file)) continue;
    if (/^(?:\.agents|\.claude|\.zcode)\//.test(file)) {
      if (/\.(mjs|json)$/.test(file)) selected.add('scripts/agent-hooks.test.mjs');
    } else if (file === 'nuwa-electron-shell') {
      result.community = result.commercial = result.compatibility = true;
      allScripts = true;
    } else if (/^nuwax(?:-dist)?$/.test(file)) {
      result.frontend = result.host_bridge = true;
    } else if (file.startsWith('overlay/')) {
      result.commercial = true;
      if (/hostBridge\.ts$/.test(file)) result.host_bridge = true;
      if (/terminal|winpty/i.test(file)) result.terminal = true;
      if (!file.includes('/src/')) scripts(file);
      else {
        tests.filter(f => graph.get(f).has(file)).forEach(f => selected.add(f));
        if (/\/services\/packages\/(?:guiAgentServer|windowsMcp)\.ts$/.test(file)) selected.add('scripts/legacy-computer-use.test.mjs');
      }
    } else if (file.startsWith('scripts/')) {
      if (file === 'scripts/ci-scope.mjs') all();
      else scripts(file);
      if (/^scripts\/(?:in-base\.js|sync-overlay\.js|check-base-purity\.js|client\/commercial-dependencies\.mjs)$/.test(file)) result.community = result.commercial = true;
      if (/terminal|winpty/i.test(file)) result.terminal = true;
      if (/host-bridge/.test(file)) result.host_bridge = true;
    } else if (file.startsWith('native/legacy-terminal/')) {
      result.terminal = true;
      selected.add('scripts/terminal-compat-resources.test.mjs');
    } else if (/^\.github\/workflows\/(?:release-electron(?:-dev)?|sync-electron-to-oss)\.yml$/.test(file)) {
      allScripts = true;
    } else if (/^(?:native|sources|third-party)\//.test(file)) {
      result.commercial = true;
      scripts(file);
    } else if (file === '.sdlc.json') selected.add('scripts/agent-hooks.test.mjs');
    else if (file !== '.gitignore') all();
  }
  result.script_tests = allScripts ? tests : tests.filter(f => selected.has(f));
  result.scripts = result.script_tests.length > 0;
  return result;
}

export function compareRefs(base, head, { cwd = root } = {}) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!base || /^0+$/.test(base)) throw new Error('Missing comparison commit');
  const files = git(['diff', '--no-renames', '--name-only', '-z', base, head]).split('\0').filter(Boolean);
  const read = (ref, file) => { try { return git(['show', `${ref}:${file}`]); } catch { return null; } };
  return files.filter(file => !/\.[cm]?[jt]sx?$/.test(file) || !commentOnly(file, read(base, file), read(head, file)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  if (args.includes('--run-scripts')) {
    const files = JSON.parse(value('--run-scripts'));
    if (!Array.isArray(files) || files.some(f => !testFiles().includes(f)) || !files.length) throw new Error('Invalid script test selection');
    const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  let full = args.includes('--full'), files = [];
  if (!full) {
    try { files = compareRefs(value('--base'), args.includes('--head') ? value('--head') : 'HEAD'); }
    catch (error) { console.error(`Cannot determine changes; running complete gates: ${error.message}`); full = true; }
  }
  const result = selectChecks(files, { full });
  console.log(JSON.stringify({ files, ...result }, null, 2));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join(''));
}
