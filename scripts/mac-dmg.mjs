#!/usr/bin/env node
/** Scoped hdiutil adapter: APFS staging on Intel without changing the signed app. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function stageDmgArgs(args, arch) {
  const result = [...args];
  if (arch !== 'x64' || result[0] !== 'create' || !result.includes('-srcfolder') ||
      result[result.indexOf('-format') + 1] !== 'UDRW') return result;
  const filesystem = result.indexOf('-fs');
  if (filesystem < 0 || result[filesystem + 1] !== 'HFS+') return result;
  result[filesystem + 1] = 'APFS';
  const fsargs = result.indexOf('-fsargs');
  if (fsargs >= 0) result.splice(fsargs, 2);
  return result;
}

const shellQuote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function createDmgEnvironment({ arch, env = process.env, log = console.log } = {}) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('[mac-dmg] Unsupported architecture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-dmg-tools-'));
  const trace = path.join(directory, 'timings.jsonl');
  try {
    const launcher = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} "$@"\n`;
    fs.writeFileSync(path.join(directory, 'hdiutil'), launcher, { mode: 0o700 });
    fs.writeFileSync(trace, '', { mode: 0o600 });
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  return {
    directory,
    env: { ...env, PATH: directory + path.delimiter + (env.PATH || ''), NUWAX_DMG_ARCH: arch, NUWAX_DMG_TRACE_FILE: trace },
    finish(requireApfs) {
      let records;
      try { records = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; }
      catch (error) {
        log('[mac-dmg] Unable to read hdiutil timings');
        // A logging failure must never hide the original electron-builder failure.
        if (requireApfs && arch === 'x64') throw new Error('[mac-dmg] Cannot verify APFS staging timings', { cause: error });
        return;
      }
      const completed = records.filter(record => record.event === 'end');
      for (const record of completed) {
        log(`[mac-dmg] ${record.phase}${record.filesystem ? ` fs=${record.filesystem}` : ''}${record.format ? ` format=${record.format}` : ''}: ${(record.elapsedMs / 1000).toFixed(2)}s (exit ${record.status})`);
      }
      for (const record of records.filter(record => record.event === 'start' && !completed.some(done => done.id === record.id))) {
        log(`[mac-dmg] ${record.phase}: interrupted before completion`);
      }
      if (requireApfs && arch === 'x64' && !completed.some(record => record.phase === 'create' && record.filesystem === 'APFS' && record.format === 'UDRW' && record.status === 0)) {
        throw new Error('[mac-dmg] Intel packaging did not use an APFS staging image');
      }
    },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

function hdiutil(args, env) {
  const forwarded = stageDmgArgs(args, env.NUWAX_DMG_ARCH);
  const id = randomUUID(), started = performance.now();
  const metadata = { id, phase: forwarded[0], ...(forwarded.includes('-fs') ? { filesystem: forwarded[forwarded.indexOf('-fs') + 1] } : {}),
    ...(forwarded.includes('-format') ? { format: forwarded[forwarded.indexOf('-format') + 1] } : {}) };
  const record = value => {
    if (!env.NUWAX_DMG_TRACE_FILE) throw new Error('[mac-dmg] Missing private timing file');
    fs.appendFileSync(env.NUWAX_DMG_TRACE_FILE, JSON.stringify({ ...metadata, ...value }) + '\n');
  };
  record({ event: 'start' });
  // stdout may be an XML plist consumed by electron-builder. Keep both streams intact.
  const result = spawnSync('/usr/bin/hdiutil', forwarded, { stdio: 'inherit', env });
  record({ event: 'end', elapsedMs: Math.round(performance.now() - started), status: result.status ?? 1 });
  if (result.error) console.error(`[mac-dmg] Unable to start hdiutil: ${result.error.message}`);
  if (result.signal) process.kill(process.pid, result.signal);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = hdiutil(process.argv.slice(2), process.env); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
