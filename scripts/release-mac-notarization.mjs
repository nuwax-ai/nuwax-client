#!/usr/bin/env node
/** Finalize one signed app before packaging. Submission state contains no credentials. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as core from './client/core.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRY_DELAYS = [15000, 30000, 60000, 60000];

export function transientAppleError(output) {
  return /NSURLErrorDomain\s+Code=-(?:1001|1005|1009)|network connection (?:was lost|appears to be offline)|No network route|timed? out|ETIMEDOUT|ECONNRESET|TLS handshake|\bEOF\b|HTTP\s*50[234]|Record not found/i.test(output);
}

async function command(tools, executable, args, { stage, retry = false, wait, timeout = 120000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const result = await tools.run(executable, args, { capture: true, allowFailure: true, timeout });
    if (result.status === 0) return result;
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (!retry || attempt >= RETRY_DELAYS.length || !transientAppleError(output)) {
      throw new Error(`[mac-notary] ${stage} failed (${result.status}): ${output}`);
    }
    tools.log?.(`[mac-notary] ${stage}: temporary Apple connection failure; retry ${attempt + 1}/${RETRY_DELAYS.length}`);
    await wait(RETRY_DELAYS[attempt]);
  }
}

async function signature(app, tools) {
  await command(tools, 'codesign', ['--verify', '--deep', '--strict', app], { stage: 'signature verification' });
  const result = await command(tools, 'codesign', ['-d', '--verbose=4', app], { stage: 'signature identity' });
  const text = `${result.stdout}\n${result.stderr}`;
  const cdhash = /^CDHash=([a-f0-9]{40})$/im.exec(text)?.[1].toLowerCase();
  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(text)?.[1];
  if (!cdhash || !team || /Signature=adhoc/.test(text)) throw new Error('[mac-notary] A valid Developer ID signature is required');
  return { cdhash, team };
}

function authArguments(auth) {
  if (!auth.key || !path.isAbsolute(auth.key) || !auth.keyId || !auth.issuer) {
    throw new Error('[mac-notary] APPLE_API_KEY file path, APPLE_API_KEY_ID and APPLE_ISSUER_ID are required');
  }
  return ['--key', auth.key, '--key-id', auth.keyId, '--issuer', auth.issuer];
}

export async function notarizeSignedApp({ app, stateFile, auth, tools = { ...core, log: console.log }, wait = sleep, maxPolls = 60 }) {
  const identity = await signature(app, tools);
  const authorization = authArguments(auth);
  let state;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.schema !== 1 || !UUID.test(state.id || '') || state.cdhash !== identity.cdhash || state.team !== identity.team) {
      throw new Error('[mac-notary] Saved submission belongs to a different signed app; refusing to reuse it');
    }
    if (state.status === 'Accepted' && state.ticketValidated === true) {
      // Re-stapling a ticket that is already present introduces a needless
      // CloudKit download. Validate the existing ticket on this unchanged app.
      await command(tools, 'xcrun', ['stapler', 'validate', '-v', app], { stage: 'existing ticket validation', retry: true, wait });
      tools.log?.('[mac-notary] Reused the existing validated ticket');
      return state.id;
    }
  } else {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-notary-'));
    try {
      const zip = path.join(temporary, 'submission.zip');
      await command(tools, 'ditto', ['-c', '-k', '--keepParent', app, zip], { stage: 'submission archive', timeout: 600000 });
      const submitted = await command(tools, 'xcrun', ['notarytool', 'submit', zip, ...authorization, '--output-format', 'json'],
        { stage: 'submission', retry: true, wait, timeout: 600000 });
      const response = JSON.parse(submitted.stdout);
      if (!UUID.test(response.id || '')) throw new Error('[mac-notary] Apple returned no valid submission ID');
      state = { schema: 1, ...identity, id: response.id, status: 'Submitted' };
      core.atomicJson(stateFile, state);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  tools.log?.(`[mac-notary] tracking submission ${state.id}`);
  let accepted = false;
  for (let poll = 0; poll < maxPolls; poll++) {
    const result = await command(tools, 'xcrun', ['notarytool', 'info', state.id, ...authorization, '--output-format', 'json'],
      { stage: 'submission status', retry: true, wait });
    const info = JSON.parse(result.stdout);
    if (info.id !== state.id) throw new Error('[mac-notary] Apple status returned a different submission ID');
    state.status = info.status;
    core.atomicJson(stateFile, state);
    if (info.status === 'Accepted') { accepted = true; break; }
    if (info.status !== 'In Progress') throw new Error(`[mac-notary] Apple rejected submission: ${info.status}`);
    if (poll + 1 < maxPolls) await wait(30000);
  }
  if (!accepted) throw new Error('[mac-notary] Apple processing exceeded the polling limit; submission ID is preserved for resume');
  const current = await signature(app, tools);
  if (current.cdhash !== identity.cdhash || current.team !== identity.team) throw new Error('[mac-notary] App changed during notarization');
  await command(tools, 'xcrun', ['stapler', 'staple', '-v', app], { stage: 'ticket staple', retry: true, wait });
  await command(tools, 'xcrun', ['stapler', 'validate', '-v', app], { stage: 'ticket validation', retry: true, wait });
  await signature(app, tools);
  core.atomicJson(stateFile, { ...state, status: 'Accepted', ticketValidated: true });
  tools.log?.('[mac-notary] Accepted; ticket embedded and validated');
  return state.id;
}

export function macAppPaths(client, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('[mac-notary] Unsupported architecture');
  const pkg = core.readJson(path.join(client, 'package.json'));
  const output = path.resolve(client, (pkg.build?.directories?.output || 'release').replaceAll('${version}', pkg.version));
  const app = path.join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Nuwax.app');
  if (!fs.existsSync(app)) throw new Error('[mac-notary] Expected signed Nuwax.app is missing');
  // Beside the app, never in the top-level public asset upload directory.
  return { app, output, stateFile: path.join(path.dirname(app), '.nuwax-notary.json') };
}

export async function packageNotarizedApp({ client, app, arch, builderCli, tools = core, wait = sleep }) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('[mac-notary] Unsupported architecture');
  const original = await signature(app, tools);
  await command(tools, 'xcrun', ['stapler', 'validate', '-v', app], { stage: 'distribution ticket validation', retry: true, wait });
  const cli = builderCli || createRequire(import.meta.url).resolve('electron-builder/out/cli/cli.js', { paths: [client] });
  // macPackager's prepackaged branch skips doPack/sign and only generates targets.
  // The final ticket must survive; a second signing pass would invalidate it.
  const result = await tools.run(process.execPath, [cli, '--prepackaged', app, '--mac', `--${arch}`, '--publish', 'never', '--config.mac.notarize=false'],
    { cwd: client, capture: false, allowFailure: true });
  if (result.status !== 0) throw new Error(`[mac-notary] Distribution packaging failed (${result.status})`);
  const final = await signature(app, tools);
  if (final.cdhash !== original.cdhash || final.team !== original.team) throw new Error('[mac-notary] Packaging changed the signed app');
  await command(tools, 'xcrun', ['stapler', 'validate', '-v', app], { stage: 'final ticket validation', retry: true, wait });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try {
    if (process.platform !== 'darwin') throw new Error('[mac-notary] Requires a native macOS runner');
    const client = path.resolve(option('--client', core.paths(process.cwd()).client));
    const arch = option('--arch', process.arch);
    const files = macAppPaths(client, arch);
    const phase = option('--phase', 'notarize');
    if (phase === 'notarize') await notarizeSignedApp({ ...files, auth: {
      key: process.env.APPLE_API_KEY, keyId: process.env.APPLE_API_KEY_ID, issuer: process.env.APPLE_ISSUER_ID,
    } });
    else if (phase === 'package') await packageNotarizedApp({ client, arch, app: files.app });
    else throw new Error('[mac-notary] Unknown phase');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
