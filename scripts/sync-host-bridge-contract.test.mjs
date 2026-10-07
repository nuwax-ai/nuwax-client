import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hostBridgeSource, hostBridgeSources, hostBridgeSnapshot, resolveHostBridgeSource, syncHostBridgeContract } from './sync-host-bridge-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(sourcePath = hostBridgeSource) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bridge-contract-'));
  temporary.push(directory);
  const source = path.join(directory, sourcePath);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'export interface HostBridgeContract { host: { getProduct(): string } }\n');
  return { directory, source, snapshot: path.join(directory, hostBridgeSnapshot) };
}

test('generates a deterministic snapshot without changing canonical source or unrelated files', () => {
  const f = fixture(), source = fs.readFileSync(f.source);
  const unrelated = path.join(f.directory, 'developer.txt'); fs.writeFileSync(unrelated, 'keep WIP');
  assert.equal(syncHostBridgeContract(f.directory).changed, true);
  const snapshot = fs.readFileSync(f.snapshot);
  assert.equal(syncHostBridgeContract(f.directory).changed, false);
  assert.deepEqual(fs.readFileSync(f.source), source);
  assert.deepEqual(fs.readFileSync(f.snapshot), snapshot);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep WIP');
});

test('resolves the renamed canonical type file and records its actual path in generated provenance', () => {
  const f = fixture(hostBridgeSources[0]);
  assert.equal(resolveHostBridgeSource(f.directory), f.source);
  assert.equal(syncHostBridgeContract(f.directory).source, f.source);
  assert.ok(fs.readFileSync(f.snapshot, 'utf8').startsWith(`// Generated from ${hostBridgeSources[0]};`));
  assert.equal(syncHostBridgeContract(f.directory, { check: true }).changed, false);
  const before = fs.readFileSync(f.snapshot);
  fs.appendFileSync(f.source, '\nexport type ChangedPayload = { visible: boolean };\n');
  assert.throws(() => syncHostBridgeContract(f.directory, { check: true }), /snapshot is stale/);
  assert.deepEqual(fs.readFileSync(f.snapshot), before);
});

test('prefers the renamed type source over a leftover legacy path without hiding content changes', () => {
  const f = fixture();
  syncHostBridgeContract(f.directory);
  const before = fs.readFileSync(f.snapshot);
  const renamed = path.join(f.directory, hostBridgeSources[0]);
  fs.writeFileSync(renamed, 'export interface HostBridgeContract { host: { getProduct(): number } }\n');
  assert.equal(resolveHostBridgeSource(f.directory), renamed);
  assert.throws(() => syncHostBridgeContract(f.directory, { check: true }), /snapshot is stale/);
  assert.deepEqual(fs.readFileSync(f.snapshot), before);
});

test('missing canonical source fails explicitly without using or changing a pre-existing snapshot', () => {
  const f = fixture();
  syncHostBridgeContract(f.directory);
  const before = fs.readFileSync(f.snapshot);
  fs.rmSync(f.source);
  for (const check of [false, true]) {
    assert.throws(() => syncHostBridgeContract(f.directory, { check }), /canonical source is missing/);
  }
  assert.deepEqual(fs.readFileSync(f.snapshot), before);
});

test('check fails on missing, edited or obsolete snapshots without writing anything', () => {
  const f = fixture();
  assert.throws(() => syncHostBridgeContract(f.directory, { check: true }), /snapshot is stale/);
  assert.equal(fs.existsSync(f.snapshot), false);
  syncHostBridgeContract(f.directory);
  const initial = fs.readFileSync(f.snapshot);
  assert.equal(syncHostBridgeContract(f.directory, { check: true }).changed, false);
  fs.appendFileSync(f.source, '\n// contract changed\n');
  assert.throws(() => syncHostBridgeContract(f.directory, { check: true }), /snapshot is stale/);
  assert.deepEqual(fs.readFileSync(f.snapshot), initial);
  fs.writeFileSync(f.snapshot, 'edited snapshot');
  assert.throws(() => syncHostBridgeContract(f.directory, { check: true }), /snapshot is stale/);
  assert.equal(fs.readFileSync(f.snapshot, 'utf8'), 'edited snapshot');
});

test('generates LF snapshots from CRLF source without rewriting canonical source', () => {
  const f = fixture();
  const source = fs.readFileSync(f.source, 'utf8').replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(f.source, source);
  assert.equal(syncHostBridgeContract(f.directory).changed, true);
  assert.equal(fs.readFileSync(f.snapshot, 'utf8').includes('\r\n'), false);
  assert.equal(fs.readFileSync(f.source, 'utf8'), source);
});

for (const [name, sourceCRLF, snapshotCRLF] of [
  ['source and snapshot use CRLF', true, true],
  ['only source uses CRLF', true, false],
  ['only snapshot uses CRLF', false, true],
]) {
  test(`normalizes line endings for read-only check when ${name}, while content changes still fail`, () => {
    const f = fixture();
    syncHostBridgeContract(f.directory);
    if (sourceCRLF) fs.writeFileSync(f.source, fs.readFileSync(f.source, 'utf8').replace(/\r?\n/g, '\r\n'));
    if (snapshotCRLF) fs.writeFileSync(f.snapshot, fs.readFileSync(f.snapshot, 'utf8').replace(/\r?\n/g, '\r\n'));
    const source = fs.readFileSync(f.source), snapshot = fs.readFileSync(f.snapshot);
    assert.equal(syncHostBridgeContract(f.directory, { check: true }).changed, false);
    assert.deepEqual(fs.readFileSync(f.source), source);
    assert.deepEqual(fs.readFileSync(f.snapshot), snapshot);

    fs.appendFileSync(f.source, sourceCRLF ? '\r\n// actual contract change\r\n' : '\n// actual contract change\n');
    const changedSource = fs.readFileSync(f.source);
    assert.throws(() => syncHostBridgeContract(f.directory, { check: true }), /snapshot is stale/);
    assert.deepEqual(fs.readFileSync(f.source), changedSource);
    assert.deepEqual(fs.readFileSync(f.snapshot), snapshot);
  });
}

// 使用已安装的基座编译器；本门不启动 Electron，也不依赖前端 Umi 产物。
const baseClient = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
const requireFromBase = createRequire(path.join(baseClient, 'package.json'));
const ts = requireFromBase('typescript');
const overlaySource = path.join(root, 'overlay/crates/agent-electron-client/src');

function compile(entry, source, { provider = false, overrides = new Map() } = {}) {
  const options = {
    strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
    typeRoots: [path.join(baseClient, 'node_modules/@types')],
    ...(provider ? {
      baseUrl: root,
      paths: {
        '@shared/*': [path.join(overlaySource, 'shared/*'), path.join(baseClient, 'src/shared/*')],
        electron: [path.join(path.dirname(requireFromBase.resolve('electron/package.json')), 'electron.d.ts')],
      },
    } : { baseUrl: path.join(root, 'nuwax'), paths: { '@/*': ['src/*'] } }),
  };
  const virtual = new Map([[entry, source], ...overrides]);
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile, fileExists = host.fileExists;
  host.readFile = filename => virtual.has(filename) ? virtual.get(filename) : readFile(filename);
  host.fileExists = filename => virtual.has(filename) || fileExists(filename);
  const program = ts.createProgram([entry], options, host);
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
}

const importType = filename => JSON.stringify(filename.replace(/\\/g, '/').replace(/\.ts$/, ''));

test('actual generated snapshot matches the selected frontend canonical contract exactly', () => {
  assert.equal(syncHostBridgeContract(root, { check: true }).changed, false);
});

test('actual preload exposure and Electron bridge alias compile against the generated contract', () => {
  const preload = path.join(overlaySource, 'preload/webviewPerfBridge.ts');
  const electronTypes = path.join(overlaySource, 'shared/types/electron.d.ts');
  const generated = path.join(root, hostBridgeSnapshot);
  const entry = path.join(root, '.host-bridge-provider-check.ts');
  const source = `
import ${importType(preload)};
import type { NuwaClawBridgeAPI } from ${importType(electronTypes)};
import type { HostBridgeContract, ClientUpdateState } from ${importType(generated)};
import type { IMReceiverBridge, IMUnreadSnapshot } from ${importType(path.join(overlaySource, 'shared/types/imReceiver.ts'))};
import type { ComputerServiceStateCommand } from ${importType(path.join(overlaySource, 'shared/types/computerServiceState.ts'))};
import type { HostCommand, HostImUnreadSnapshot } from ${importType(generated)};
import type { ClientUpdateState as UpdaterState } from ${importType(path.join(baseClient, 'src/shared/types/updateTypes.ts'))};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type BridgeAlias = Assert<Equal<NuwaClawBridgeAPI, HostBridgeContract>>;
type ImAlias = Assert<Equal<IMReceiverBridge, NonNullable<HostBridgeContract['im']>>>;
type UnreadAlias = Assert<Equal<IMUnreadSnapshot, HostImUnreadSnapshot>>;
type ComputerCommand = Assert<Equal<ComputerServiceStateCommand, Extract<HostCommand, { type: 'computer-service-state' }>>>;
declare const nativeUpdate: UpdaterState;
const wireUpdate: ClientUpdateState = nativeUpdate;
const updaterUpdate: UpdaterState = wireUpdate;
`;
  assert.deepEqual(compile(entry, source, { provider: true }), []);

  // 故意把真实暴露对象的 updater 回包退回宽泛 Record，必须在 satisfies 接线处失败。
  const broken = fs.readFileSync(preload, 'utf8').replace('getState(): Promise<ClientUpdateState | null>', 'getState(): Promise<Record<string, unknown> | null>');
  const diagnostics = compile(entry, source, { provider: true, overrides: new Map([[preload, broken]]) });
  assert.ok(diagnostics.some(diagnostic => diagnostic.file === preload && /getState|ClientUpdateState/.test(diagnostic.message)), JSON.stringify(diagnostics));
});

test('frontend window keeps optional legacy capabilities and typed command/theme/update/IM payloads without Electron', () => {
  const canonical = resolveHostBridgeSource(root);
  const globals = path.join(root, 'nuwax/src/types/global.d.ts');
  const entry = path.join(root, 'nuwax/.host-bridge-consumer-check.ts');
  const source = `
/// <reference path=${JSON.stringify(globals.replace(/\\/g, '/'))} />
import type { CompatibleHostBridge, HostBridgeContract, HostImUnreadSnapshot } from ${importType(canonical)};
import { hostBridge as consumer } from ${importType(path.join(root, 'nuwax/src/utils/hostBridge/index.ts'))};
import type { HostAuthContext } from ${importType(path.join(root, 'nuwax/src/types/interfaces/hostAuth.ts'))};
import type { HostImUnreadSnapshot as ExistingUnreadSnapshot } from ${importType(path.join(root, 'nuwax/src/types/interfaces/im.ts'))};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type WindowContract = Assert<Equal<NonNullable<Window['NuwaClawBridge']>, CompatibleHostBridge>>;
type ConsumerUpdate = Assert<Equal<Awaited<ReturnType<typeof consumer.updater.getState>>, ClientUpdateState | null>>;
type ConsumerAuth = Assert<Equal<Awaited<ReturnType<typeof consumer.auth.getContext>>, HostAuthContext | null>>;
type UnreadAlias = Assert<Equal<ExistingUnreadSnapshot, HostImUnreadSnapshot>>;
const oldHost: CompatibleHostBridge = { auth: { syncSession: async () => true } };
const emptyHost: CompatibleHostBridge = {};
window.NuwaClawBridge = oldHost;
window.NuwaClawBridge?.events?.onHostCommand?.(command => {
  if (command.type === 'host-activity') { const visible: boolean = command.visible; }
  if (command.type === 'computer-service-state') { const sandbox: string | undefined = command.sandboxId; }
});
const theme: ShellThemePayload = { active: true, primary: '#fff' };
window.NuwaClawBridge?.theme?.syncTheme?.(theme);
window.NuwaClawBridge?.im?.onUnreadChanged?.(snapshot => {
  const revision: number | undefined = snapshot?.revision;
});
async function update() {
  const state = await window.NuwaClawBridge?.updater?.getState?.();
  const status: ClientUpdateState['status'] | undefined = state?.status;
}
// @ts-expect-error 状态命令必须提供 visible。
const invalidCommand: HostCommand = { type: 'host-activity' };
// @ts-expect-error 主题必须提供 active。
const invalidTheme: ShellThemePayload = { primary: '#fff' };
// @ts-expect-error 更新状态保持枚举。
const invalidState: ClientUpdateState = { status: 'unexpected', hostVersion: '1.0' };
// @ts-expect-error IM 快照必须带修订号。
const invalidIM: HostImUnreadSnapshot = { sessionGeneration: 1, total: 0, dndTotal: 0 };
// @ts-expect-error 旧宿主的方法可能缺省，必须检测后调用。
oldHost.native.openWindow('/home');
declare const completeHost: HostBridgeContract;
const compatibleHost: CompatibleHostBridge = completeHost;
`;
  assert.deepEqual(compile(entry, source), []);
});
