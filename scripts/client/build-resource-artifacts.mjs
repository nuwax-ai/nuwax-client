/** Optional, cross-ref build resources. GitHub's tag-scoped actions/cache is
 * deliberately not used here. Only successful same-repository platform jobs
 * on the release / maintenance allowlist may produce reusable resources. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';
import { output, report } from './resource-report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const client = 'nuwa-electron-shell/crates/agent-electron-client';
const branches = new Set(['main', 'fix/stable-3.0.22']);
const releaseWorkflows = new Set(['.github/workflows/release-electron.yml', '.github/workflows/release-electron-dev.yml']);
const warmer = '.github/workflows/warm-build-resources.yml';
const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const archiveName = /(?:\.(?:zip|tar\.gz|tar\.xz|tar\.bz2|tgz|7z\.exe)|^SHASUMS256\.txt)$/;
const arch = process.env.TARGET_ARCH || process.arch;
const maxBytes = 2 * 1024 ** 3;

function roots(kind) {
  if (kind === 'helper') return ['.cache/client-toolchain/cua-helper'];
  if (kind === 'capture') return [
    `resources/capture/${process.platform}-${arch}`, 'resources/capture/sources',
    '.cache/client-toolchain/capture-koffi', '.cache/client-toolchain/capture/downloads',
    '.cache/client-toolchain/capture/windows-runtime',
    ...['ffmpeg', 'libvpx', 'openh264', 'koffi'].map(name => `third-party/licenses/${name}.txt`),
  ];
  if (kind === 'bundled') return [
    ...['node', 'git', 'uv', 'ripgrep'].map(name => `${client}/resources/${name}/.cache`),
    `${client}/scripts/resources/nuwaxcode-cache`,
  ];
  throw new Error('Unknown resource kind');
}

function relative(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || /[\x00-\x1f:]/.test(file)
    || path.posix.isAbsolute(file) || file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe resource path');
  }
  return file;
}

function owner(kind, file) {
  relative(file);
  const owned = roots(kind).find(base => file === base || file.startsWith(base + '/'));
  if (!owned || file.split('/').some(part => /\.app$/i.test(part))) throw new Error('Resource is outside the unsigned cache allowlist');
  if (kind === 'bundled' && (!archiveName.test(path.posix.basename(file)) || path.posix.dirname(file) !== owned)) {
    throw new Error('Bundled cache accepts download archives only');
  }
  if (kind === 'helper' && !/^[a-f0-9]{64}\.(?:bin|json)$/.test(file.slice(owned.length + 1))) {
    throw new Error('Helper cache accepts compiler output and its hash record only');
  }
  return owned;
}

function noLinks(file, base = root) {
  let current = base;
  const baseStat = fs.lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('Cache base is not a real directory');
  for (const part of relative(file).split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
      throw new Error('Linked or special cache entry rejected');
    }
  }
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

const stateFile = (kind, key) => path.join(process.env.RUNNER_TEMP || os.tmpdir(), `nuwax-resource-${kind}-${core.fingerprint(key)}.json`);
const identity = kind => ({ schema: 1, kind, platform: process.platform, arch });
const prefix = (kind, key) => `build-resource-v1-${kind}-${key}`;

async function api(endpoint) {
  if (!process.env.GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY || '')) throw new Error('GitHub resource read credentials unavailable');
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`GitHub resource API returned ${response.status}`);
  return response.json();
}

async function trustRun(run) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || !commit.test(run.head_sha || '')
    || (run.pull_requests || []).length) throw new Error('Producer is not a same-repository non-PR run');
  if (run.path === warmer && branches.has(run.head_branch) && ['push', 'workflow_dispatch'].includes(run.event)) return;
  if (!releaseWorkflows.has(run.path) || run.event !== 'push' || !/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(run.head_branch || '')) {
    throw new Error('Producer workflow, event or ref is not trusted');
  }
  let reference = (await api(`git/ref/tags/${encodeURIComponent(run.head_branch)}`)).object;
  for (let depth = 0; reference?.type === 'tag' && depth < 4; depth++) reference = (await api(`git/tags/${reference.sha}`)).object;
  if (reference?.type !== 'commit' || reference.sha !== run.head_sha) throw new Error('Release tag no longer matches producer SHA');
}

async function ancestor(source, current) {
  if (!commit.test(source) || !commit.test(current)) throw new Error('Invalid producer or consumer SHA');
  if (source === current) return;
  const compare = await api(`compare/${source}...${current}`);
  if (compare.status !== 'ahead' || compare.merge_base_commit?.sha !== source || compare.base_commit?.sha !== source) {
    throw new Error('Producer source is not an ancestor of the current source');
  }
}

function currentSha() { return core.git(root, ['rev-parse', 'HEAD']); }

async function producer() {
  const run = await api(`actions/runs/${process.env.GITHUB_RUN_ID}`);
  await trustRun(run);
  if (run.head_sha !== currentSha()) throw new Error('Producer checkout does not match run SHA');
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const jobs = await api(`actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
  const matches = jobs.jobs.filter(job => job.name === process.env.NUWAX_RESOURCE_JOB_NAME
    && job.runner_name === process.env.RUNNER_NAME && job.status === 'in_progress' && job.head_sha === run.head_sha);
  if (matches.length !== 1) throw new Error('Cannot uniquely identify the producing platform job');
  return { repository: process.env.GITHUB_REPOSITORY, runId: run.id, attempt, jobId: matches[0].id,
    source: run.head_sha, workflow: run.path, event: run.event, ref: run.head_branch };
}

async function stage(kind, key) {
  let prior;
  try { prior = core.readJson(stateFile(kind, key)); } catch { prior = { hit: false }; }
  if (prior.hit) { output({ ready: false }); return 'already restored; no duplicate upload'; }
  const source = await producer();
  const files = [];
  let bytes = 0;
  async function collect(file) {
    noLinks(file);
    const full = path.join(root, file);
    if (!fs.existsSync(full)) return;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(full).sort()) {
        if (kind === 'bundled' && !archiveName.test(child)) continue;
        await collect(file + '/' + child);
      }
      return;
    }
    owner(kind, file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024 ** 2) throw new Error('Invalid cache file');
    bytes += stat.size;
    if (bytes > maxBytes || files.length >= 20000) throw new Error('Resource cache exceeds size limits');
    if (kind === 'capture' && /(?:resource|koffi)\.json$/.test(file) && core.readJson(full).signing) throw new Error('Signed capture records are not cacheable');
    const digest = await hash(full);
    files.push({ path: file, sha256: digest, bytes: stat.size, mode: kind === 'bundled' ? 0o644 : (stat.mode & 0o111 ? 0o755 : 0o644) });
  }
  for (const base of roots(kind)) await collect(base);
  if (!files.length) throw new Error('No reusable resource files were produced');
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nuwax-resource-upload-'));
  try {
    const blobs = path.join(directory, 'blobs');
    fs.mkdirSync(blobs);
    for (const file of files) {
      if (!fs.existsSync(path.join(blobs, file.sha256))) fs.copyFileSync(path.join(root, file.path), path.join(blobs, file.sha256));
    }
    core.atomicJson(path.join(directory, 'manifest.json'), { ...identity(kind), key, producer: source, files });
    output({ ready: true, path: directory, name: `${prefix(kind, key)}-a${source.attempt}` });
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  return `${files.length} files, ${bytes} bytes; producer run ${source.runId}, job ${source.jobId}`;
}

function invalidateRestoredState(kind, key, reason) {
  const filename = stateFile(kind, key);
  let previous = { hit: false };
  try { previous = core.readJson(filename); } catch {}
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = { hit: false };
  core.atomicJson(filename, { hit: false, invalidated: true, reason,
    ...(previous.producerRun ? { previousProducerRun: previous.producerRun } : {}),
    ...(previous.artifact ? { previousArtifact: previous.artifact } : {}) });
  return previous.hit ? `restored artifact ${previous.artifact ?? 'unknown'} marked stale: ${reason}` : `no prior hit state: ${reason}`;
}

async function download(artifact, temporary) {
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') || artifact.size_in_bytes > maxBytes) throw new Error('Artifact digest or size is unavailable');
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    redirect: 'manual', signal: AbortSignal.timeout(60000),
  });
  const location = response.headers.get('location');
  if (response.status !== 302 || !location?.startsWith('https://')) throw new Error('Artifact download did not provide an HTTPS archive');
  // Never forward the GitHub token to the signed blob URL.
  const blob = await fetch(location, { signal: AbortSignal.timeout(180000) });
  if (!blob.ok || !blob.body) throw new Error('Artifact archive download failed');
  const zip = path.join(temporary, 'artifact.zip');
  const fd = fs.openSync(zip, 'wx');
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of blob.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('Artifact download exceeds size limit');
      fs.writeSync(fd, chunk); digest.update(chunk);
    }
  } finally { fs.closeSync(fd); }
  if (`sha256:${digest.digest('hex')}` !== artifact.digest) throw new Error('Artifact archive digest mismatch');
  const unpacked = path.join(temporary, 'unpacked');
  // The envelope contains only hash-addressed regular blobs. Validate every
  // central-directory entry before extracting anything, entirely outside the
  // checkout. No tar, symlink, hardlink or producer-controlled output path.
  core.run('python3', ['-c', `import os,re,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist(); names=set(); total=0
 if len(entries)>20001: raise ValueError('Too many artifact entries')
 for item in entries:
  name=item.filename; mode=item.external_attr>>16; total+=item.file_size
  if name in names or not re.fullmatch(r'manifest\\.json|blobs/[a-f0-9]{64}',name): raise ValueError('Unsafe artifact entry')
  if stat.S_IFMT(mode) not in (0,stat.S_IFREG) or item.file_size>512*1024**2 or total>2*1024**3: raise ValueError('Linked/special/oversized artifact entry')
  if name=='manifest.json' and item.file_size>4*1024**2: raise ValueError('Oversized manifest')
  names.add(name)
 if 'manifest.json' not in names: raise ValueError('Manifest missing')
 for item in entries:
  target=os.path.join(sys.argv[2],*item.filename.split('/')); os.makedirs(os.path.dirname(target),exist_ok=True)
  with z.open(item) as source,open(target,'xb') as dest:
   while True:
    chunk=source.read(1024*1024)
    if not chunk: break
    dest.write(chunk)
`, zip, unpacked], { capture: true, timeout: 180000 });
  return unpacked;
}

async function install(kind, key, artifact, run, unpacked) {
  const record = core.readJson(path.join(unpacked, 'manifest.json'));
  const expected = identity(kind);
  if (Object.entries(expected).some(([name, value]) => record[name] !== value) || record.key !== key) throw new Error('Resource identity mismatch');
  const source = record.producer;
  if (!source || source.repository !== process.env.GITHUB_REPOSITORY || source.runId !== run.id || source.source !== run.head_sha
    || source.workflow !== run.path || source.event !== run.event || source.ref !== run.head_branch || !Number.isSafeInteger(source.attempt)
    || !Number.isSafeInteger(source.jobId) || source.jobId < 1 || source.attempt < 1 || source.attempt > run.run_attempt
    || artifact.name !== `${prefix(kind, key)}-a${source.attempt}`) throw new Error('Producer manifest mismatch');
  const job = await api(`actions/jobs/${source.jobId}`);
  if (job.run_id !== run.id || job.head_sha !== source.source || job.status !== 'completed' || job.conclusion !== 'success') {
    throw new Error('Producing platform job did not complete successfully');
  }
  // Verify that the successful job belongs to the declared attempt as well.
  const jobs = await api(`actions/runs/${run.id}/attempts/${source.attempt}/jobs?per_page=100`);
  if (!jobs.jobs.some(item => item.id === job.id)) throw new Error('Producer job attempt mismatch');
  await ancestor(source.source, currentSha());
  if (!Array.isArray(record.files) || !record.files.length || record.files.length > 20000) throw new Error('Invalid resource file manifest');
  const seen = new Set();
  const owned = new Set();
  let bytes = 0;
  for (const file of record.files) {
    owned.add(owner(kind, file.path));
    const collision = file.path.toLowerCase();
    if (seen.has(collision) || !sha.test(file.sha256 || '') || ![0o644, 0o755].includes(file.mode)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 512 * 1024 ** 2) throw new Error('Invalid or duplicate resource entry');
    seen.add(collision); bytes += file.bytes;
    const blob = path.join(unpacked, 'blobs', file.sha256);
    if (bytes > maxBytes || !fs.lstatSync(blob).isFile() || fs.statSync(blob).size !== file.bytes || await hash(blob) !== file.sha256) {
      throw new Error('Resource file SHA256 or size mismatch');
    }
    noLinks(file.path);
    if (kind === 'capture' && /(?:resource|koffi)\.json$/.test(file.path) && core.readJson(blob).signing) throw new Error('Signed capture cache rejected');
  }
  noLinks('.cache'); fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const staging = fs.mkdtempSync(path.join(root, '.cache', 'resource-install-'));
  const replaced = [];
  let removeStaging = true;
  try {
    // Materialize only after ALL paths and hashes have passed validation.
    for (const file of record.files) {
      const destination = path.join(staging, 'new', file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(unpacked, 'blobs', file.sha256), destination);
      fs.chmodSync(destination, file.mode);
    }
    for (const base of owned) {
      noLinks(base);
      const destination = path.join(root, base);
      const backup = path.join(staging, 'old', base);
      const hadPrevious = fs.existsSync(destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (hadPrevious) fs.renameSync(destination, backup);
      replaced.push({ destination, backup, hadPrevious });
      fs.renameSync(path.join(staging, 'new', base), destination);
    }
  } catch (error) {
    try {
      for (const item of replaced.reverse()) {
        fs.rmSync(item.destination, { recursive: true, force: true });
        if (item.hadPrevious) fs.renameSync(item.backup, item.destination);
      }
    } catch (rollbackError) {
      removeStaging = false;
      throw new Error(`Cache replacement rollback failed; backups retained at ${staging}: ${rollbackError.message}`);
    }
    throw error;
  } finally { if (removeStaging) fs.rmSync(staging, { recursive: true, force: true }); }
  return `run ${run.id}, attempt ${source.attempt}, job ${job.id}; ${record.files.length} SHA256-verified files. Preparation/admission still runs.`;
}

async function restore(kind, key) {
  core.atomicJson(stateFile(kind, key), { hit: false });
  let rejected = 0;
  // Bounded search of immutable repository artifacts, across tag/branch refs.
  // No restore-keys fallback: the complete build identity must match exactly.
  for (let page = 1; page <= 5; page++) {
    const result = await api(`actions/artifacts?per_page=100&page=${page}`);
    const candidates = result.artifacts.filter(item => !item.expired && item.workflow_run?.id !== Number(process.env.GITHUB_RUN_ID)
      && item.name.startsWith(prefix(kind, key) + '-a'));
    for (const artifact of candidates) {
      const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nuwax-resource-download-'));
      try {
        const run = await api(`actions/runs/${artifact.workflow_run.id}`);
        await trustRun(run);
        await ancestor(run.head_sha, currentSha());
        const unpacked = await download(artifact, temporary);
        const detail = await install(kind, key, artifact, run, unpacked);
        core.atomicJson(stateFile(kind, key), { hit: true, producerRun: run.id, artifact: artifact.id });
        output({ hit: true }); return { hit: true, detail };
      } catch (error) {
        rejected++;
        console.warn(`[build-resource] rejected artifact ${artifact.id}: ${error.message}`);
        if (rejected >= 5) return { hit: false, detail: 'Five candidate resources rejected; cold preparation will run' };
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
    if (result.artifacts.length < 100) break;
  }
  output({ hit: false });
  return { hit: false, detail: `No admissible exact-key artifact within the latest 500 entries; ${rejected} rejected; cold preparation will run` };
}

function bundledKey() {
  const inputs = ['scripts/client/build-resource-artifacts.mjs', 'scripts/client/core.mjs'];
  for (const directory of [`${client}/scripts/prepare`, `${client}/scripts/utils`]) {
    for (const entry of fs.readdirSync(path.join(root, directory)).sort()) {
      if (/\.[cm]?js$/.test(entry) && fs.lstatSync(path.join(root, directory, entry)).isFile()) inputs.push(directory + '/' + entry);
    }
  }
  // Do not include product package.version. Exact preparation source includes
  // pinned upstream versions/hashes; each run re-extracts/adopts downloads.
  const recipe = inputs.map(file => {
    const digest = core.fileHash(path.join(root, file));
    if (!digest) throw new Error('Missing bundled preparation input');
    return [file, digest];
  });
  const basePin = core.git(root, ['rev-parse', 'HEAD:nuwa-electron-shell']);
  return `bundled-v4-${process.platform}-${arch}-${core.fingerprint({ recipe, basePin })}`;
}

const [command, kind, key, ...args] = process.argv.slice(2);
const started = Date.now();
if (command === 'bundled-key') output({ key: bundledKey() });
else if (command === 'measure' && key === '--' && args.length) {
  roots(kind);
  const result = core.run(args[0], args.slice(1), { allowFailure: true });
  report(kind, result.status === 0 ? 'preparation/admission completed' : 'preparation failed', started);
  process.exitCode = result.status;
} else {
  try {
    roots(kind);
    if (!/^[a-zA-Z0-9._-]{1,180}$/.test(key || '')) throw new Error('Exact resource key unavailable');
    if (command === 'restore') {
      const result = await restore(kind, key);
      report(kind, result.hit ? 'HIT (artifact verified)' : 'MISS', started, result.detail);
    } else if (command === 'invalidate') {
      const reason = args[0] || 'unspecified';
      if (!/^[a-zA-Z0-9._-]{1,80}$/.test(reason)) throw new Error('Invalid cache invalidation reason');
      const detail = invalidateRestoredState(kind, key, reason);
      output({ invalidated: true });
      report(kind, 'invalidated', started, detail);
    } else if (command === 'save') report(kind, 'cache staging', started, await stage(kind, key));
    else throw new Error('Unknown resource operation');
  } catch (error) {
    // Caching is optional. Never convert a network/permission/validation miss
    // into a failed release, or skip the original resource preparation.
    if (command === 'invalidate') {
      console.error(`[build-resource] ${kind || 'unknown'}: cache invalidation failed: ${error.message}`);
      process.exitCode = 1;
    } else {
      output({ hit: false, ready: false });
      report(kind || 'unknown', 'MISS / cache unavailable', started, error.message);
    }
  }
}
