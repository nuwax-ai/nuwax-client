#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { selectTasks, SUITE_VERSION, summarize, failureCategory, checkFixture, checkNative, buildAgentConfig, digest, cancellable, observationArgs } from './real-core.mjs';
import { startModelProxy, probeVision, modelTotals } from './real-model.mjs';
import { AcpPeer, executableArchitecture, probeAgentStartup } from './real-acp.mjs';
import { startHelper, prepareTarget, isolatedAgentEnv, sleep, checkInteractiveDesktop } from './real-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const shaFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function parseArgs(argv) {
  const flags = new Set(['--list', '--build-only', '--preflight']);
  const values = new Set(['--helper','--agent','--browser','--runtime','--output','--tasks','--repeat','--mode','--modality','--timeout-ms','--input-usd-per-million','--output-usd-per-million']);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg)) opts[arg.slice(2)] = true;
    else if (values.has(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[arg.slice(2)] = argv[++i];
    else throw new Error('invalidArgument');
  }
  opts.repeat = Number(opts.repeat ?? 1); opts.timeout = Number(opts['timeout-ms'] ?? 180000);
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1 || opts.repeat > 100 || !Number.isInteger(opts.timeout) || opts.timeout < 1000 || opts.timeout > 900000) throw new Error('invalidBudget');
  opts.mode ??= 'background'; opts.modality ??= 'hybrid';
  if (!['background','foreground'].includes(opts.mode) || !['hybrid','ax'].includes(opts.modality)) throw new Error('invalidMode');
  if (opts['input-usd-per-million'] !== undefined || opts['output-usd-per-million'] !== undefined) {
    const input = Number(opts['input-usd-per-million']), output = Number(opts['output-usd-per-million']);
    if (![input, output].every(n => Number.isFinite(n) && n >= 0)) throw new Error('invalidPrices');
    opts.prices = { input, output, basis: 'explicit-blended-input-rate' };
  }
  return opts;
}

async function loadRuntime(opts) {
  let file = opts.runtime, buildSource;
  if (!file) {
    const out = path.join(repo, '.cache/cua-real-bench'); fs.mkdirSync(out, { recursive: true }); file = path.join(out, 'runtime.cjs');
    const require = createRequire(import.meta.url);
    const esbuild = require(path.join(repo, 'nuwa-electron-shell/crates/agent-electron-client/node_modules/esbuild'));
    await esbuild.build({ entryPoints: [path.join(here, 'real-runtime.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: file,
      alias: { '@shared': path.join(repo, 'overlay/crates/agent-electron-client/src/shared') }, logLevel: 'silent' });
    buildSource = provenance();
    fs.writeFileSync(file + '.source.json', JSON.stringify({ sha256: shaFile(file), source: buildSource }) + '\n');
  } else if (fs.existsSync(file + '.source.json')) {
    const manifest = JSON.parse(fs.readFileSync(file + '.source.json', 'utf8'));
    if (manifest.sha256 !== shaFile(file)) throw new Error('runtimeProvenanceMismatch');
    buildSource = manifest.source;
  }
  const runtime = await import(pathToFileURL(path.resolve(file)).href);
  return { runtime, runtimeSha256: shaFile(file), runtimePath: path.resolve(file), buildSource };
}

function provenance() {
  try {
    const commit = execFileSync('git', ['rev-parse','HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
    const files = execFileSync('git', ['ls-files','-m','-o','--exclude-standard','-z'], { cwd: repo }).toString().split('\0').filter(Boolean).sort();
    const hashes = files.filter(f => fs.existsSync(path.join(repo, f)) && fs.statSync(path.join(repo, f)).isFile()).map(f => [f, shaFile(path.join(repo, f))]);
    return { commit, dirtySha256: digest(hashes), submodules: execFileSync('git', ['submodule','status'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).slice(0,2)) };
  } catch { return { commit: null, dirtySha256: null }; }
}

async function runTask(task, iteration, opts, daemon, runtime, proxy, agent, model) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nct-')); fs.chmodSync(root, 0o700);
  const result = { task: task.id, iteration, kind: task.kind, category: task.category, status: 'failed', interventions: 0,
    durationMs: 0, reason: null, failure: null, oraclePassed: false, calls: [], mode: opts.mode, modality: opts.modality };
  const started = Date.now(), modelStart = proxy.records.length;
  const registry = new runtime.CuaTaskRegistry(); registry.setAvailable(true);
  const authority = new runtime.CuaSessionAuthority();
  let target, gateway, grant, taskState, peer, sessionId, timer, polling, off, finalizing = false, stop;
  const cancelled = new Promise(resolve => { stop = reason => { if (!finalizing && !result.reason) { result.reason = reason;
    if (taskState) registry.pauseTask(taskState.id, reason); resolve(); if (sessionId) peer?.notify('session/cancel', { sessionId }); } }; });
  const onAbort = () => stop('runCancelled'); opts.signal?.addEventListener('abort', onAbort, { once: true });
  const revoke = async () => {
    if (!grant || !taskState) return true;
    registry.pauseTask(taskState.id, result.reason ?? 'benchmarkFinished');
    let context; try { context = registry.nativeContext(grant.owner); } catch { return false; }
    let reply = await daemon.request('nuwax_task', 'revoke', context);
    for (let i = 0; i < 30 && !reply.result?.drained; i++) { await sleep(100); reply = await daemon.request('nuwax_task', 'status', context); }
    return reply.ok && reply.result?.revoked === true && reply.result?.drained === true;
  };
  try {
    target = await prepareTarget(task, daemon, root, opts.browser, opts.mode); result.application = target.application;
    if (opts.signal?.aborted) throw new Error('runCancelled');
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\nuwax-cu-bench-g-' + randomUUID() : path.join(root, 'g');
    authority.configure(path.join(root, 'grants'), file => ({ command: process.execPath, args: ['-e', runtime.CUA_STDIO_RELAY],
      env: { NUWAX_CUA_GATEWAY: socket, NUWAX_CUA_GATEWAY_TOKEN: daemon.tokenFile, NUWAX_CUA_SESSION_FILE: file } }), () => {});
    gateway = new runtime.CuaMcpGateway({ controller: registry, tasks: registry, allowedTools: runtime.CUA_WINDOW_TASK_TOOLS,
      visibleTools: () => runtime.CUA_WINDOW_TASK_TOOLS, authorize: secret => authority.authorize(secret), scope: owner => registry.scopeFor(owner ?? ''),
      transformCall: (tool, args, owner) => runtime.taskCuaCall(registry.scopeFor(owner), registry.byId(taskState.id).mode, tool,
        observationArgs(tool, args, opts.modality)),
      beforeCall: async (owner, call) => { const context = registry.nativeContext(owner); const reply = await daemon.request('nuwax_task','bind',context);
        if (!reply.ok) throw new Error('targetClosed'); return { ...call, args: { ...call.args, _nuwax_task: context } }; },
      onResult: (tool, args, outcome, value) => { const code = value?.code ?? value?.refusal?.code;
        result.calls.push({ tool, outcome, hasSnapshot: args.snapshot_id !== undefined, hasElementToken: args.element_token !== undefined,
          ...(typeof code === 'string' && /^[\w-]{1,80}$/.test(code) ? { code } : {}) }); },
      launch: () => { const child = spawn(daemon.binary, ['mcp','--socket',daemon.socketPath], { env: daemon.env, stdio: ['pipe','pipe','pipe'], windowsHide: true }); child.stderr.resume(); return child; },
      onFailure: reason => stop(reason), timeoutMs: Math.min(opts.timeout, 120000),
    });
    await gateway.listen(socket, daemon.token);
    const servers = [{ name: 'cua' }]; grant = authority.issue(servers); authority.start(grant);
    taskState = registry.ensure(grant.owner); registry.bind(taskState.id, { pid: target.pid, windowId: target.windowId, label: target.label });
    if (opts.mode === 'foreground') registry.setMode(taskState.id, 'foreground');
    if (!registry.resumeTask(taskState.id)) throw new Error('taskResumeFailed');
    const bind = await daemon.request('nuwax_task', 'bind', registry.nativeContext(grant.owner));
    if (!bind.ok) throw new Error('targetBindFailed');
    const window = await daemon.request('nuwax_task', 'window', registry.nativeContext(grant.owner));
    if (!window.result?.valid) throw new Error('targetWindowNotVisible');
    if (opts.mode === 'background' && window.result.foreground) throw new Error('backgroundTargetInForeground');
    peer = new AcpPeer(agent, ['acp'], { cwd: root, env: isolatedAgentEnv(root, buildAgentConfig({ model, baseUrl: proxy.url, proxyToken: proxy.token })) }, ({ update }) => {
      if (update?.sessionUpdate === 'tool_call') {
        const title = update.title ?? '';
        if (!/^cua[_:]/i.test(title)) stop('boundaryViolation');
      }
    });
    result.stage = 'agentInitialize';
    await cancellable(peer.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'nuwax-cu-benchmark', version: SUITE_VERSION } }, 120000), opts.signal);
    result.stage = 'agentNewSession';
    const session = await cancellable(peer.request('session/new', { cwd: root, mcpServers: servers,
      _meta: { systemPrompt: runtime.CUA_TASK_GUIDANCE + '\nOnly cua tools are available. Do not use filesystem, terminal, web/network tools or delegate. Task success requires checking the actual UI result.' } }, 120000), opts.signal);
    sessionId = session.sessionId;
    off = registry.subscribe(() => { const state = registry.stateForOwner(grant.owner); if (state?.phase === 'paused' || state?.phase === 'failed' || state?.phase === 'stopped') stop(state.reason ?? 'taskPaused'); });
    polling = setInterval(async () => {
      if (finalizing || polling.busy) return; polling.busy = true;
      try { const reply = await daemon.request('nuwax_task','window',registry.nativeContext(grant.owner));
        if (!reply.result?.valid) stop('targetClosed');
        else if (opts.mode === 'background' && reply.result.foreground) stop('userTakingControl');
      } catch { stop('helperUnavailable'); } finally { polling.busy = false; }
    }, 500);
    timer = setTimeout(() => stop('timeLimit'), opts.timeout);
    result.stage = 'modelExecution'; result.modelExecutionStarted = true;
    const prompt = peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: task.goal + '\n仅操作已绑定的测试窗口；完成后重新观察核验结果。' }] }, opts.timeout + 10000);
    await Promise.race([prompt, cancelled]);
    finalizing = true; clearTimeout(timer); clearInterval(polling); off?.();
    await sleep(250);
    result.stage = 'oracle';
    if (task.kind === 'fixture') {
      result.oraclePassed = checkFixture(task, target.fixture.state);
      result.oracleChecks = Object.fromEntries(Object.entries(task.expected).map(([key, value]) => [key, target.fixture.state[key] === value]));
      result.oracleChecks.noWrongSelection = target.fixture.state.wrong !== true;
    }
    else if (!result.reason) {
      const context = registry.nativeContext(grant.owner);
      const reply = await daemon.request('call','get_window_state', { pid: context.pid, window_id: context.window_id,
        _nuwax_task: registry.nativeContext(grant.owner), capture_mode: 'ax', include_screenshot: false, max_elements: 200 });
      result.oraclePassed = checkNative(task, reply);
    }
    result.stats = registry.stateForOwner(grant.owner)?.stats;
    result.steps = registry.stateForOwner(grant.owner)?.steps;
    if (!result.reason && result.oraclePassed) result.status = 'passed';
  } catch (error) {
    result.reason ??= /^[\w-]{1,80}$/.test(error.message) ? error.message : 'benchmarkExecutionFailed';
    result.failureStage = result.stage ?? 'targetPreparation';
    if (!result.modelExecutionStarted) result.status = 'blocked';
  } finally {
    finalizing = true; clearTimeout(timer); clearInterval(polling); off?.();
    opts.signal?.removeEventListener('abort', onAbort);
    try { result.drained = await revoke(); } catch { result.drained = false; }
    if (!result.drained) { result.status = 'failed'; result.reason = 'nativeDrainFailed'; }
    if (grant) { authority.finish(grant, grant.turn, true); authority.remove(grant); }
    const cleanup = await Promise.allSettled([peer?.close(), gateway?.close()]);
    if (peer?.exit) result.agentExit = peer.exit;
    try { await target?.close(); } catch { result.cleanupFailed = true; }
    if (cleanup.some(r => r.status === 'rejected')) result.cleanupFailed = true;
    Object.assign(result, modelTotals(proxy.records.slice(modelStart), opts.prices));
    result.durationMs = Date.now() - started;
    result.failure = result.status === 'passed' ? null : failureCategory({ reason: result.reason, oracle: result.oraclePassed, calls: result.calls, blocked: result.status === 'blocked' });
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { result.cleanupFailed = true; }
    if (result.cleanupFailed) { result.status = 'failed'; result.reason = 'benchmarkCleanupFailed'; result.failure = 'harness'; }
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv); const tasks = selectTasks(opts.tasks);
  if (opts.list) { console.log(JSON.stringify(tasks.map(({id,kind,category,title}) => ({id,kind,category,title})), null, 2)); return; }
  const modelApiKey = process.env.CUA_MODEL_API_KEY;
  // Keep the provider key in this process's memory, never in subprocess envs
  // (including build tools, test applications and the native helper).
  delete process.env.CUA_MODEL_API_KEY;
  const built = await loadRuntime(opts);
  if (opts['build-only']) { console.log(JSON.stringify({ runtimePath: built.runtimePath, runtimeSha256: built.runtimeSha256, source: provenance() })); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncb-')); fs.chmodSync(root, 0o700);
  const output = path.resolve(opts.output ?? path.join(repo, '.cache/cua-real-bench', `results-${Date.now()}-${process.platform}.json`));
  const report = { suite: SUITE_VERSION, taskSetSha256: digest(tasks), at: new Date().toISOString(), platform: process.platform, arch: process.arch,
    plannedTasks: tasks.map(({ id, kind, category }) => ({ id, kind, category })),
    osRelease: os.release(), node: process.version, runtimeSha256: built.runtimeSha256, source: provenance(), runtimeBuildSource: built.buildSource ?? null,
    mode: opts.mode, modality: opts.modality, repeat: opts.repeat, timeoutMs: opts.timeout, model: process.env.CUA_MODEL,
    prices: opts.prices ?? null, evidence: 'development-real-model', preflight: {}, results: [] };
  const write = () => { report.summary = summarize(report.results, tasks.length * opts.repeat); fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output + '.partial', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(output + '.partial', output); };
  const cancellation = new AbortController(); opts.signal = cancellation.signal;
  const interrupt = () => cancellation.abort(); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let daemon, proxy;
  try {
    if (!['darwin','win32'].includes(process.platform)) throw new Error('platformUnsupported');
    checkInteractiveDesktop(); report.preflight.desktop = 'interactive';
    if (!opts.helper || !opts.agent || !fs.existsSync(opts.agent)) throw new Error('helperOrAgentMissing');
    report.agentSha256 = shaFile(opts.agent);
    report.agentArchitecture = executableArchitecture(opts.agent);
    report.preflight.agent = await probeAgentStartup(path.resolve(opts.agent), { cwd: root,
      env: isolatedAgentEnv(root, {}), signal: opts.signal });
    if (!report.preflight.agent.passed) throw new Error(report.preflight.agent.reason);
    daemon = await startHelper(path.resolve(opts.helper), root, built.runtime); report.helperSha256 = shaFile(daemon.binary);
    report.preflight.helper = { windowTasks: daemon.metadata.nuwax_window_tasks, preview: daemon.metadata.nuwax_window_preview };
    if (!process.env.CUA_MODEL || !modelApiKey || !process.env.CUA_MODEL_BASE_URL) throw new Error('modelConfigurationMissing');
    proxy = await startModelProxy({ model: process.env.CUA_MODEL, baseUrl: process.env.CUA_MODEL_BASE_URL, apiKey: modelApiKey });
    if (opts.modality === 'hybrid') { report.preflight.vision = await probeVision(proxy, process.env.CUA_MODEL); if (!report.preflight.vision.passed) throw new Error(report.preflight.vision.reason); }
    if (opts.preflight) { report.preflight.only = true; write(); return; }
    for (let iteration = 1; iteration <= opts.repeat; iteration++) for (const task of tasks) {
      if (opts.signal.aborted) throw new Error('runCancelled');
      console.log(`[real-bench] ${process.platform} ${task.id} #${iteration} starting`);
      const result = await runTask(task, iteration, opts, daemon, built.runtime, proxy, path.resolve(opts.agent), process.env.CUA_MODEL);
      report.results.push(result); write(); console.log(`[real-bench] ${task.id} ${result.status} ${result.reason ?? result.failure ?? ''} calls=${result.calls.length}`);
      if (result.failure === 'control-boundary' || !result.drained) throw new Error('controlBoundaryFailed');
      if (result.cleanupFailed) throw new Error('benchmarkCleanupFailed');
      if (result.status === 'blocked' && /^agent/.test(result.reason ?? '')) throw new Error('agentStartupBlocked');
    }
  } catch (error) { report.blocker = /^[\w-]{1,80}$/.test(error.message) ? error.message : 'benchmarkSetupFailed';
    console.error('[real-bench] failure location', error.code ?? error.name, String(error.stack).split('\n').slice(1, 3).join('\n')); process.exitCode = 2; }
  finally { await proxy?.close(); await daemon?.close(); write(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); console.log(`[real-bench] report ${output}`); }
  if (report.results.some(r => r.status !== 'passed')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('realBenchmarkFailed'); process.exitCode = 2; });
}
