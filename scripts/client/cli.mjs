#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { withLock } from './core.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const valueFlags = new Set(['frontend', 'port', 'version', 'channel', 'nuwax', 'shell', 'output']);
const booleanFlags = new Set(['json', 'dry-run', 'refresh-resources', 'dir', 'no-build', 'force-build',
  'with-test', 'no-commit', 'no-push-dist', 'push', 'force', 'notes', 'help']);
const camel = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const commandFlags = {
  help: [], doctor: ['json'],
  'frontend:build': ['dry-run'],
  dev: ['frontend', 'port', 'refresh-resources', 'dry-run'],
  setup: ['frontend', 'refresh-resources', 'dry-run'],
  pack: ['frontend', 'refresh-resources', 'version', 'output', 'dir', 'dry-run'],
  'sub:update': ['nuwax', 'shell', 'no-build', 'force-build', 'with-test', 'no-commit', 'no-push-dist', 'push', 'force', 'dry-run'],
  release: ['channel', 'version', 'notes', 'dry-run'],
};
export function parseArgs(argv) {
  const [command = 'help', ...args] = argv, options = {};
  if (!Object.hasOwn(commandFlags, command)) throw new Error('Unknown command: ' + command);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw new Error('Unexpected argument: ' + args[i]);
    const [flag, inline] = args[i].slice(2).split(/=(.*)/s);
    if (flag !== 'help' && !commandFlags[command].includes(flag)) throw new Error('--' + flag + ' is not supported by ' + command);
    if (booleanFlags.has(flag)) {
      if (inline !== undefined) throw new Error('--' + flag + ' does not take a value');
      options[camel(flag)] = true;
    } else if (valueFlags.has(flag)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error('--' + flag + ' requires a value');
      options[camel(flag)] = value;
    } else throw new Error('Unknown option: --' + flag);
  }
  if (options.frontend && !['dist', 'source'].includes(options.frontend)) throw new Error('--frontend must be dist or source');
  if (options.port) {
    options.port = Number(options.port);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be 1..65535');
  }
  return { command, options };
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'help' || options.help) {
    console.log('Nuwax: dev [--frontend source], frontend:build, pack [--frontend source] [--dir],');
    console.log('       sub:update [--nuwax ref] [--shell ref] [--push],');
    console.log('       release --channel stable|beta --version X.Y.Z [--dry-run], doctor [--json]');
    return;
  }
  if (command === 'doctor') return (await import('./doctor.mjs')).doctor(root, options);
  const actions = {
    'frontend:build': async () => (await import('./frontend.mjs')).buildFrontend(root, { ...options, restoreGenerated: true }),
    dev: async () => (await import('./dev.mjs')).dev(root, options),
    pack: async () => (await import('./pack.mjs')).pack(root, options),
    setup: async () => (await import('./prepare.mjs')).prepare(root, options),
    'sub:update': async () => (await import('./update.mjs')).update(root, options),
    release: async () => (await import('./release.mjs')).release(root, options),
  };
  if (!actions[command]) throw new Error('Unknown command: ' + command);
  if (options.noCommit && options.push) throw new Error('--no-commit cannot be combined with --push');
  if (options.noBuild && options.forceBuild) throw new Error('--no-build cannot be combined with --force-build');
  return options.dryRun ? actions[command]() : withLock(root, 'operation', actions[command]);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error('[client] ' + error.message); process.exitCode = 1; });
}
