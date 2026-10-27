'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  SUPPORTED_BUILDER_VERSION, BLOCKMAP_HOOK, LEGACY_BLOCKMAP_HOOK,
  installedBuilderVersions, applyInstallerArchivePolicy,
} = require('./installer-archive-policy.cjs');

const PREFIX = '[windows-installers]';
const UPDATER_HOOK = 'scripts/build/app-update-config.cjs';
const SIGN_HOOK = 'scripts/build/after-sign.js';
const SIGNING_ENV = ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD',
  'WINDOWS_CERTIFICATE_SHA1', 'WINDOWS_CERTIFICATE_PATH', 'WINDOWS_CERTIFICATE_PASSWORD'];
const SIGNING_OPTIONS = ['sign', 'signtoolOptions', 'azureSignOptions', 'certificateFile',
  'certificateSha1', 'certificateSubjectName', 'certificatePassword'];
const OTHER_HOOKS = ['beforeBuild', 'beforePack', 'afterExtract', 'artifactBuildStarted',
  'artifactBuildCompleted', 'msiProjectCreated', 'onNodeModuleFile'];
const PARALLEL_APP_COPY_COUNT = 2n;
const PARALLEL_CACHE_COPY_COUNT = 2n;
const INSTALLER_WORKING_APP_MULTIPLIER = 4n;
const PARALLEL_DISK_RESERVE_BYTES = 1024n ** 3n;

function parallelSpaceRequirement(appBytes, cacheBytes) {
  // After --dir, the original app/cache already consume disk. In SDK 25.1.8,
  // NsisTarget retains its .nsis.zip while emitting the EXE; MsiTarget uses a
  // separate WiX staging directory and final MSI. Allow 4 app-sized units for
  // simultaneous archive/staging/output, plus both physical app/cache copies.
  // This is a conservative admission budget, not a measured installer size or
  // a guarantee about arbitrary tool behavior. Reserve 1 GiB for new toolsets,
  // archive headers and other small files; uncertain readings choose serial.
  return (PARALLEL_APP_COPY_COUNT + INSTALLER_WORKING_APP_MULTIPLIER) * appBytes
    + PARALLEL_CACHE_COPY_COUNT * cacheBytes + PARALLEL_DISK_RESERVE_BYTES;
}

function directoryBytes(directory) {
  let bytes = 0n;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isDirectory()) bytes += directoryBytes(file);
    else if (stat.isFile()) bytes += stat.size;
    else throw new Error(`unsupported entry while measuring ${file}`);
  }
  return bytes;
}

function inspectParallelSpace(app, cache, volumePath, statfs) {
  try {
    const appBytes = directoryBytes(app), cacheBytes = directoryBytes(cache);
    const stats = statfs(volumePath, { bigint: true });
    const blocks = BigInt(stats.bavail), blockSize = BigInt(stats.bsize);
    if (blocks < 0n || blockSize <= 0n) throw new Error('invalid statfs free-disk values');
    const availableBytes = blocks * blockSize;
    const requiredBytes = parallelSpaceRequirement(appBytes, cacheBytes);
    return { parallel: availableBytes >= requiredBytes, appBytes, cacheBytes, availableBytes, requiredBytes,
      reason: `${availableBytes >= requiredBytes ? 'sufficient' : 'insufficient'} free disk: available=${availableBytes}B, parallel budget=${requiredBytes}B, measured app=${appBytes}B, cache=${cacheBytes}B` };
  } catch (error) {
    return { parallel: false, reason: `cannot read prepared payload/cache size or free disk: ${error.message}` };
  }
}

// Restrict the first rollout to the two CI release entry points. A custom build
// retains the single electron-builder invocation, including its signing order.
function parallelInstallerEligibility({ pkg, argv, env = process.env, platform = process.platform,
  arch = process.arch, builderVersions } = {}) {
  const no = reason => ({ eligible: false, reason });
  if (env.NUWAX_WINDOWS_PARALLEL_INSTALLERS === '0') return no('disabled by NUWAX_WINDOWS_PARALLEL_INSTALLERS=0');
  if (platform !== 'win32' || arch !== 'x64') return no('requires a native Windows x64 build');
  if (env.GITHUB_ACTIONS !== 'true' || env.NUWAX_APP_IDENTIFIER !== 'nuwax') return no('requires the commercial Actions release entry point');
  if (env.NUWAX_WINDOWS_INSTALLER_ARCHIVE) return no('archive QA modes keep the original builder invocation');
  if (!builderVersions || Object.values(builderVersions).length !== 2
      || Object.values(builderVersions).some(version => version !== SUPPORTED_BUILDER_VERSION)) return no('requires the audited electron-builder and app-builder-lib 25.1.8');
  // Do not reinterpret arbitrary CLI overrides: the standard dist:win command
  // has only --win, optional --x64, and one explicit --publish never.
  const args = [...(argv ?? [])];
  let win = 0, publish = 0, x64 = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--win') win++;
    else if (args[i] === '--x64') x64++;
    else if (args[i] === '--publish=never') publish++;
    else if (args[i] === '--publish' && args[++i] === 'never') publish++;
    else return no('custom CLI targets or overrides keep the original builder invocation');
  }
  if (win !== 1 || publish !== 1 || x64 > 1) return no('requires --win and exactly one explicit --publish never');
  const build = pkg?.build;
  if (!build || build.extends) return no('external builder configuration keeps the original invocation');
  const output = env.NUWAX_WINDOWS_OUTPUT_DIR;
  if (!output || !path.win32.isAbsolute(output) || output.length > 80
      || path.win32.normalize(output) !== path.win32.normalize(build.directories?.output ?? '')) return no('requires the configured short Windows release output directory');
  const targets = build.win?.target;
  if (!Array.isArray(targets) || targets.length !== 2
      || !['msi', 'nsis'].every(name => targets.some(target => target?.target === name
        && Array.isArray(target.arch) && target.arch.length === 1 && target.arch[0] === 'x64'))) return no('requires the standard MSI and NSIS x64 target pair');
  if (build.afterPack !== UPDATER_HOOK) return no('requires the known commercial updater and uninstall-inventory afterPack hook');
  if (build.afterSign && build.afterSign !== SIGN_HOOK) return no('custom afterSign hook keeps its original invocation');
  if (build.afterAllArtifactBuild && ![BLOCKMAP_HOOK, LEGACY_BLOCKMAP_HOOK].includes(build.afterAllArtifactBuild)) return no('custom artifact hook keeps its original invocation');
  if (OTHER_HOOKS.some(name => build[name])) return no('custom builder hooks keep their original invocation');
  if (SIGNING_ENV.some(name => env[name]) || SIGNING_OPTIONS.some(name => build.win?.[name])
      || build.forceCodeSigning || build.win?.forceCodeSigning) return no('configured Windows signing keeps its original serialized invocation');
  // Both release workflows intentionally produce unsigned Windows installers;
  // stable SimplySign runs later on the complete artifact set, as before.
  return { eligible: true, reason: 'standard unsigned Windows release', output, arch: 'x64' };
}

function createBuilderOptions(pkg, job, api) {
  // Let the SDK load package.json itself. Passing the full build object back
  // would trigger 25.1.8's special publish-array merge and duplicate file sets.
  // Validate policy conflicts against the actual config before using overrides.
  const policyOptions = {
    env: {}, platform: 'win32', builderVersions: {
      electronBuilder: SUPPORTED_BUILDER_VERSION, appBuilderLib: SUPPORTED_BUILDER_VERSION,
    },
  };
  applyInstallerArchivePolicy(pkg.build, policyOptions);
  const config = applyInstallerArchivePolicy({}, policyOptions);
  return {
    projectDir: job.projectRoot, publish: 'never',
    targets: api.Platform.WINDOWS.createTarget(job.stage === 'serial' ? ['msi', 'nsis'] : job.stage === 'app' ? 'dir' : job.stage, api.Arch.x64),
    ...(job.stage === 'app' ? {} : { prepackaged: job.app }),
    config: { ...config, directories: { output: job.output } },
  };
}

async function runBuilderJob(job) {
  const versions = installedBuilderVersions(job.projectRoot);
  if (Object.values(versions).some(version => version !== SUPPORTED_BUILDER_VERSION)) throw new Error(`${PREFIX} SDK version changed after preflight`);
  const sdkRequire = createRequire(require.resolve('electron-builder/package.json', { paths: [job.projectRoot] }));
  const api = sdkRequire('app-builder-lib');
  const pkg = JSON.parse(fs.readFileSync(path.join(job.projectRoot, 'package.json'), 'utf8'));
  const options = createBuilderOptions(pkg, job, api);
  let platformPackager;
  options.platformPackagerFactory = (info, platform) => {
    if (platform !== api.Platform.WINDOWS) throw new Error(`${PREFIX} Unexpected platform`);
    platformPackager = new api.WinPackager(info);
    return platformPackager;
  };
  // build() awaits PublishManager metadata writes and the configured standalone
  // blockmap hook. A receipt is never written for an incomplete target.
  await api.build(options);
  const appOutDir = platformPackager.computeAppOutDir(job.output, api.Arch.x64);
  if (job.stage === 'app') {
    const publish = pkg.build.publish;
    require('./app-update-config.cjs').verifyResources(path.join(appOutDir, 'resources'), publish?.[0]?.url);
    const inventory = path.join(job.projectRoot, 'dist/installer-uninstall/payload-x64.json');
    if (!fs.statSync(inventory).isFile()) throw new Error(`${PREFIX} Missing commercial uninstall inventory`);
  }
  fs.writeFileSync(job.receipt, JSON.stringify({ output: job.output, appOutDir }));
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) return;
  // Windows runtime payloads/inventories reject symlinks already. Fail closed
  // here too, so target writes cannot follow a link back into a shared source.
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false,
    filter(file) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${PREFIX} Cannot isolate symbolic link: ${file}`);
      return true;
    } });
}

function runChild(job, env, workerFile) {
  const jobFile = path.join(path.dirname(job.receipt), 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    console.log(`${PREFIX} ${job.stage} started`);
    const child = spawn(process.execPath, workerFile === __filename ? [workerFile, '--job', jobFile] : [workerFile, jobFile], {
      cwd: job.projectRoot, stdio: 'inherit',
      env: { ...env, ELECTRON_BUILDER_CACHE: job.cache, TEMP: job.temp, TMP: job.temp, TMPDIR: job.temp },
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`${PREFIX} ${job.stage} failed (exit ${code}, signal ${signal ?? 'none'})`));
      try {
        const receipt = JSON.parse(fs.readFileSync(job.receipt, 'utf8'));
        if (receipt.output !== job.output || !fs.statSync(receipt.appOutDir).isDirectory()
            || (job.stage !== 'app' && path.resolve(receipt.appOutDir) !== path.resolve(job.app))) throw new Error('invalid completion receipt');
        console.log(`${PREFIX} ${job.stage} completed in ${Math.round((Date.now() - started) / 1000)}s`);
        resolve(receipt);
      } catch (error) { reject(new Error(`${PREFIX} ${job.stage} failed: ${error.message}`)); }
    });
  });
}

function sha256(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function collectArtifacts(jobs) {
  const files = new Map();
  for (const job of jobs) {
    for (const entry of fs.readdirSync(job.output, { withFileTypes: true })) {
      // Stage/debug output remains internal. Only final distribution files and
      // builder-generated updater metadata can enter the atomic promotion.
      if (!entry.isFile() || /^builder-(?:debug|effective-config)\./i.test(entry.name)
          || !/\.(?:exe|msi|blockmap|ya?ml)$/i.test(entry.name)) continue;
      const file = path.join(job.output, entry.name);
      if (!fs.statSync(file).size) throw new Error(`${PREFIX} Empty artifact: ${entry.name}`);
      const key = entry.name.toLowerCase();
      const previous = files.get(key);
      if (previous && sha256(previous.file) !== sha256(file)) throw new Error(`${PREFIX} Conflicting artifact: ${entry.name}`);
      if (!previous) files.set(key, { name: entry.name, file });
    }
  }
  const names = [...files.values()].map(file => file.name);
  const executables = names.filter(name => /\.exe$/i.test(name));
  if (names.filter(name => /\.msi$/i.test(name)).length !== 1 || executables.length !== 1
      || !files.has(`${executables[0]}.blockmap`.toLowerCase())
      || !names.some(name => /\.ya?ml$/i.test(name))) throw new Error(`${PREFIX} Incomplete MSI, NSIS, blockmap or updater metadata set`);
  return [...files.values()];
}

function assertEmptyOutput(output) {
  if (fs.existsSync(output) && (!fs.lstatSync(output).isDirectory() || fs.readdirSync(output).length)) throw new Error(`${PREFIX} Final output must be absent or empty: ${output}`);
}

async function orchestrateInstallers({ projectRoot, output, arch, env = process.env }, { workerFile = __filename, keepWork = false, statfs = fs.statfsSync } = {}) {
  if (arch !== 'x64' || !path.isAbsolute(output)) throw new Error(`${PREFIX} Expected an absolute x64 output directory`);
  assertEmptyOutput(output);
  const work = fs.mkdtempSync(path.join(path.dirname(output), 'ni-'));
  const makeJob = stage => {
    const dir = path.join(work, stage);
    const job = { stage, projectRoot, arch, output: path.join(dir, 'o'), app: path.join(dir, 'a'),
      cache: path.join(dir, 'c'), temp: path.join(dir, 't'), receipt: path.join(dir, 'done.json') };
    for (const key of ['output', 'temp']) fs.mkdirSync(job[key], { recursive: true });
    return job;
  };
  const app = makeJob('app');
  try {
    // app-builder's Windows default is %LOCALAPPDATA%/electron-builder/Cache.
    // Seed a private cache read-only; target processes then inherit its warmed
    // contents and only download their distinct missing WiX / NSIS tools.
    const sourceCache = env.ELECTRON_BUILDER_CACHE || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
    copyTree(sourceCache, app.cache);
    fs.mkdirSync(app.cache, { recursive: true });
    const prepared = await runChild(app, env, workerFile);
    if (path.resolve(prepared.appOutDir) !== path.join(app.output, 'win-unpacked')) throw new Error(`${PREFIX} Unexpected prepared application directory`);
    const space = inspectParallelSpace(prepared.appOutDir, app.cache, work, statfs);
    const mode = space.parallel ? 'parallel' : 'serial';
    console.log(`${PREFIX} disk guard chose ${mode}: ${space.reason}`);
    let targetJobs, nsisApp;
    if (space.parallel) {
      const msi = makeJob('msi'), nsis = makeJob('nsis');
      targetJobs = [msi, nsis];
      for (const job of targetJobs) {
        copyTree(prepared.appOutDir, job.app);
        copyTree(app.cache, job.cache);
      }
      // allSettled is intentional: on failure no process may still write while
      // callers clean up or the next CI step examines the final output.
      const results = await Promise.allSettled(targetJobs.map(job => runChild(job, env, workerFile)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      nsisApp = nsis.app;
    } else {
      // Reuse the already prepared/signed application and warmed cache. The
      // pinned SDK orders MSI before NSIS in one prepackaged dual-target build;
      // its input is mutated only by the later NSIS elevate.exe step, as before.
      const serial = { ...makeJob('serial'), app: prepared.appOutDir, cache: app.cache };
      targetJobs = [serial];
      await runChild(serial, env, workerFile);
      nsisApp = prepared.appOutDir;
    }
    const artifacts = collectArtifacts(targetJobs);
    const candidate = path.join(work, 'complete');
    fs.mkdirSync(candidate);
    // All target validation and conflict checks have finished. These paths are
    // on the same work volume: move large installers without another full copy.
    // A failed move leaves its bytes inside work, never in the public output.
    for (const artifact of artifacts) fs.renameSync(artifact.file, path.join(candidate, artifact.name));
    // MSI historically precedes NSIS and therefore does not contain this file.
    // Keep the final unpacked app identical to the post-NSIS shape for scans.
    const elevate = path.join(nsisApp, 'resources/elevate.exe');
    if (nsisApp !== prepared.appOutDir && fs.existsSync(elevate)) fs.copyFileSync(elevate, path.join(prepared.appOutDir, 'resources/elevate.exe'));
    fs.renameSync(prepared.appOutDir, path.join(candidate, 'win-unpacked'));
    assertEmptyOutput(output);
    if (fs.existsSync(output)) fs.rmdirSync(output);
    fs.renameSync(candidate, output);
    console.log(`${PREFIX} Promoted complete MSI + NSIS + updater artifacts to ${output}`);
    if (!keepWork) {
      try { fs.rmSync(work, { recursive: true, force: true }); }
      catch (error) { console.warn(`${PREFIX} Complete output is ready; temporary cleanup failed at ${work}: ${error.message}`); }
    }
    return { output, work, artifacts: artifacts.map(file => file.name), mode, space };
  } catch (error) {
    console.error(`${PREFIX} No partial artifacts promoted; diagnostics: ${work}`);
    throw error;
  }
}

async function main(argv) {
  if (argv[0] === '--job' && argv.length === 2) return runBuilderJob(JSON.parse(fs.readFileSync(argv[1], 'utf8')));
  if (argv.length !== 6 || argv[0] !== '--project' || argv[2] !== '--output' || argv[4] !== '--arch') throw new Error(`${PREFIX} Expected --project path --output path --arch x64`);
  const projectRoot = argv[1], output = argv[3], arch = argv[5];
  const eligibility = parallelInstallerEligibility({
    pkg: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')),
    argv: ['--win', '--publish', 'never'], arch, builderVersions: installedBuilderVersions(projectRoot),
  });
  if (!eligibility.eligible || eligibility.output !== output) throw new Error(`${PREFIX} Ineligible invocation: ${eligibility.reason}`);
  await orchestrateInstallers({ projectRoot, output, arch });
}

module.exports = { parallelInstallerEligibility, createBuilderOptions, orchestrateInstallers,
  parallelSpaceRequirement, PARALLEL_DISK_RESERVE_BYTES };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
