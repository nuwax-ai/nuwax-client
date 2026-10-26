/**
 * 桌面特性静态注册表 + 运行时：特性接入客户端的唯一汇合点（公开入口）。
 *
 * 新增一个特性 = 在 `features/<id>/` 写一个 `DesktopFeature`，并在 `desktopFeatures` 加一行。
 * 不做动态加载；加载与否由 `products`、`lockedOff` 与开关决定（见 `_kit/register.ts`）。
 *
 * 客户端其余代码只通过这里使用特性：
 *   - `prepareDesktopFeaturesBeforeReady`：app ready 前声明协议、准备命令行；
 *   - `startDesktopFeatures`：在 IPC 注册阶段调用一次，注入宿主端口实现；
 *   - 生命周期：`emitFeatureSessionInvalidated` / `runFeatureServicesStarting` /
 *     `runFeatureServicesStopping` / `notifyFeatureSessionEnd` / `disposeDesktopFeatures`；
 *   - 托盘：`desktopFeatureActivities` / `onDesktopFeatureActivitiesChanged` / `runDesktopActivity`；
 *   - Agent 引擎：`createDesktopAgentSessions`；
 *   - canUse 与请求门：`isFeatureCapabilityAvailable` / `authorizeDesktopFeatureRequest` /
 *     `isDesktopFeatureRequestSource`。
 * 本文件不 import 数据库或客户端服务，所有宿主能力由调用方注入，便于单测。
 */

import type { CommandLine, CustomScheme, OnBeforeRequestListenerDetails } from "electron";
import * as nodePath from "node:path";
import { createActivityBoard, type ActivityBoard, type ActivityEntry } from "./_kit/activities";
import { createAgentSessions, type AgentSessionParticipant, type AgentSessions, type AgentTurn } from "./_kit/agentSessions";
import { createFeatureLifecycle, type FeatureLifecycleHost, type SessionEndReason } from "./_kit/lifecycle";
import { registerDesktopFeatures, type RegisteredFeatures } from "./_kit/register";
import { createScratchDir } from "./_kit/scratchDir";
import { createTrustedIpc, type IpcMainLike, type TrustedIpc } from "./_kit/trustedIpc";
import type {
  DesktopFeature,
  FeatureAgent,
  FeatureContext,
  FeatureLogger,
  FeatureRequestSource,
  FeatureSession,
  FeatureSettings,
  FeatureWindows,
  FeatureWorkspaceServices,
  FeaturePermissionServices,
} from "./_kit/types";
import { computerUseFeature } from "./computer-use";
import { captureFeature } from "./capture";
import { openSourceNoticesFeature } from "./open-source-notices";
import { localFilesFeature } from "./local-files";

export type { SessionEndReason, ActivityEntry, AgentSessions, AgentTurn, AgentSessionParticipant };
export type { FeatureMcpServerEntry } from "./_kit/types";

/** 顺序即托盘「进行中操作」的展示顺序。 */
export const desktopFeatures: readonly DesktopFeature[] = [
  computerUseFeature,
  captureFeature,
  openSourceNoticesFeature,
  localFilesFeature,
];

/** 宿主仅供壳渲染进程读取已注册特性（用于显示/隐藏入口）。 */
export const FEATURES_REGISTERED_IPC = "features:registered";

export interface FeatureHostServices {
  settings: FeatureSettings;
  session: FeatureSession;
  windows: FeatureWindows;
  agent: Omit<FeatureAgent, "registerSessionParticipant">;
}

export interface StartFeaturesOptions {
  product: string;
  ipcMain: IpcMainLike;
  /** 业务页调用方是否受信（受信顶层文档且为当前代次）。 */
  isBusinessSender(event: never): boolean;
  /** 宿主壳渲染进程调用方是否受信。 */
  isHostSender(event: never): boolean;
  /** 客户端数据目录（`~/.nuwax`）；各特性的目录建在其下。 */
  dataDir: string;
  /** 运行期开关：设置项覆盖 ?? 清单默认值。 */
  isEnabled(featureId: string, enabledByDefault: boolean): boolean;
  log: FeatureLogger;
  translate?(key: string): string;
  host?: FeatureHostServices;
  workspace?: FeatureWorkspaceServices;
  permissions?: FeaturePermissionServices;
}

const inertHost: FeatureHostServices = {
  settings: { read: () => undefined, write: () => false },
  session: { isAuthenticated: () => false },
  windows: { getMain: () => null },
  agent: {
    setLocalMcpServer: async () => undefined,
    hasLocalMcpServer: () => false,
    resolveNodeBinary: () => null,
  },
};

let currentProduct: string | null = null;
let started: {
  options: StartFeaturesOptions;
  features: readonly DesktopFeature[];
  lifecycle: FeatureLifecycleHost;
  registered: RegisteredFeatures;
  board: ActivityBoard;
  hostChannel: TrustedIpc;
  offBoard: () => void;
} | null = null;
let shutdown: Promise<void> | null = null;
const participantFactories = new Map<string, () => AgentSessionParticipant>();
const activityListeners = new Set<(entries: ActivityEntry[]) => void>();

const forProduct = (features: readonly DesktopFeature[], product: string | null) =>
  product === null ? features : features.filter((feature) => feature.products.includes(product));

/** Electron 要求 scheme 在 app ready 前一次性声明；handler 仍受开关控制。 */
export function prepareDesktopFeaturesBeforeReady(product: string, commandLine: CommandLine): CustomScheme[] {
  currentProduct = product;
  const features = forProduct(desktopFeatures, product);
  for (const feature of features) feature.beforeReady?.(commandLine);
  return features.flatMap((feature) => [...(feature.schemes ?? [])]);
}

/** 原生宿主入口读取实际注册结果，关闭或注册失败时不显示入口。 */
export function isDesktopFeatureRegistered(id: string): boolean {
  return started?.registered.ids.includes(id) === true;
}

export function startDesktopFeatures(
  options: StartFeaturesOptions,
  features: readonly DesktopFeature[] = desktopFeatures,
): RegisteredFeatures {
  if (started) return started.registered;
  shutdown = null;
  currentProduct = options.product;
  const host = options.host ?? inertHost;
  const lifecycle = createFeatureLifecycle((error) =>
    options.log.error("[Features] lifecycle listener failed", error),
  );
  const board = createActivityBoard(features.map((feature) => feature.id), (error) =>
    options.log.error("[Features] activity listener failed", error),
  );
  const offBoard = board.subscribe((entries) => {
    for (const listener of [...activityListeners]) {
      try {
        listener(entries);
      } catch (error) {
        options.log.error("[Features] activity listener failed", error);
      }
    }
  });

  const createContext = (feature: DesktopFeature): FeatureContext => ({
    product: options.product,
    ipc: createTrustedIpc(options.ipcMain, options.isBusinessSender),
    hostIpc: createTrustedIpc(options.ipcMain, options.isHostSender),
    lifecycle,
    scratch: createScratchDir(nodePath.join(options.dataDir, feature.id)),
    dataDir: nodePath.join(options.dataDir, feature.id),
    log: options.log,
    translate: options.translate,
    settings: host.settings,
    session: host.session,
    windows: host.windows,
    activities: board.forFeature(feature.id),
    agent: {
      setLocalMcpServer: (id, entry) => host.agent.setLocalMcpServer(id, entry),
      hasLocalMcpServer: (id) => host.agent.hasLocalMcpServer(id),
      resolveNodeBinary: () => host.agent.resolveNodeBinary(),
      registerSessionParticipant: (factory) => registerDesktopAgentSessionParticipant(feature.id, factory),
    },
    workspace: options.workspace,
    permissions: options.permissions,
  });

  const registered = registerDesktopFeatures(features, {
    product: options.product,
    isEnabled: options.isEnabled,
    createContext,
    log: options.log,
  });
  const hostChannel = createTrustedIpc(options.ipcMain, options.isHostSender);
  hostChannel.handle(FEATURES_REGISTERED_IPC, () => [...(started?.registered.ids ?? [])], [] as string[]);
  started = { options, features, lifecycle, registered, board, hostChannel, offBoard };
  return registered;
}

/** 登录失效的第一时间：同步撤销各特性对外能力，不等待任何队列。 */
export function emitFeatureSessionInvalidated(): void {
  started?.lifecycle.emitSessionInvalidated();
}

/** 业务服务与 Agent 引擎启动前：先清理未启用特性残留的 MCP 条目，再等待各特性就绪。 */
export async function runFeatureServicesStarting(signal: AbortSignal): Promise<void> {
  const current = started;
  if (!current) return;
  const agent = (current.options.host ?? inertHost).agent;
  for (const id of reservedInactiveServers()) {
    if (signal.aborted) return;
    try {
      if (agent.hasLocalMcpServer(id)) await agent.setLocalMcpServer(id, null);
    } catch (error) {
      current.options.log.warn(`[Features] failed to remove inactive MCP entry ${id}`, error);
    }
  }
  await current.lifecycle.emitServicesStarting(signal);
}

/** 随业务服务停止：并行等待各特性清理，任一失败视为停止失败。 */
export async function runFeatureServicesStopping(): Promise<{ success: boolean }> {
  const failed = (await started?.lifecycle.emitServicesStopping()) ?? 0;
  return { success: failed === 0 };
}

/** 登出 / 换域：通知各特性取消进行中的工作并清理。 */
export function notifyFeatureSessionEnd(reason: SessionEndReason = "other"): void {
  started?.lifecycle.emitSessionEnd(reason);
}

/**
 * 应用退出：先通知退出，再逆序释放全部特性。幂等：重复调用等待同一次收尾，
 * 供退出清理链在更长的步进上限内再次等待（见 `settleDesktopFeaturesForQuit`）。
 */
export function disposeDesktopFeatures(): Promise<void> {
  if (shutdown) return shutdown;
  const current = started;
  started = null;
  participantFactories.clear();
  shutdown = (async () => {
    if (!current) return;
    current.board.clear();
    current.offBoard();
    current.hostChannel.dispose();
    await current.lifecycle.emitQuit();
    await current.registered.dispose();
  })();
  return shutdown;
}

export const settleDesktopFeaturesForQuit = disposeDesktopFeatures;

export function desktopFeatureActivities(): ActivityEntry[] {
  return started?.board.list() ?? [];
}

export function onDesktopFeatureActivitiesChanged(listener: (entries: ActivityEntry[]) => void): () => void {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
}

/** 托盘不可用时（如部分 Linux 桌面）由宿主快捷键直接执行特性当前登记的动作。 */
export function runDesktopActivity(featureId: string, actionId: string): boolean {
  return started?.board.run(featureId, actionId) ?? false;
}

function reservedInactiveServers(): Set<string> {
  // 特性尚未启动时没有「未启用」判断依据，不剥离任何条目。
  if (!started) return new Set();
  const ids = new Set(started.registered.ids);
  return new Set(started.features
    .filter((feature) => !ids.has(feature.id))
    .flatMap((feature) => [...(feature.agentServers ?? [])]));
}

/**
 * 登记 Agent 会话参与者工厂（特性的 `ctx.agent.registerSessionParticipant` 调用同一入口；
 * 宿主测试也可直接使用）。同 featureId 后写覆盖先写。
 */
export function registerDesktopAgentSessionParticipant(
  featureId: string,
  factory: () => AgentSessionParticipant,
): () => void {
  participantFactories.set(featureId, factory);
  return () => {
    if (participantFactories.get(featureId) === factory) participantFactories.delete(featureId);
  };
}

/** 每个 Agent 引擎一份；参与者按当前注册表惰性解析。 */
export function createDesktopAgentSessions(): AgentSessions {
  return createAgentSessions({
    factories: () => participantFactories,
    reservedInactive: reservedInactiveServers,
  });
}

/**
 * canUse 的特性归属判定：命名空间不归任何特性时返回 undefined（由宿主自行判定）；
 * 归属特性未注册或运行期开关已关时为 false，否则叠加清单的 canUse。
 */
export function isFeatureCapabilityAvailable(namespace: string, capability: string): boolean | undefined {
  const features = started?.features ?? desktopFeatures;
  const owner = features.find((feature) => feature.bridge?.namespaces.includes(namespace));
  if (!owner) return undefined;
  if (!started || !started.registered.ids.includes(owner.id)) return false;
  try {
    if (!started.options.isEnabled(owner.id, owner.enabledByDefault)) return false;
  } catch {
    return false;
  }
  return owner.bridge?.canUse?.(capability) ?? true;
}

/** Invoked by the existing single Session request listener, never installs another. */
export function authorizeDesktopFeatureRequest(details: OnBeforeRequestListenerDetails): boolean | undefined {
  for (const feature of forProduct(desktopFeatures, currentProduct)) {
    const decision = feature.requests?.authorize(details);
    if (decision !== undefined) return decision;
  }
  return undefined;
}

/** Share preview provenance with the existing credential-filtering listener. */
export function isDesktopFeatureRequestSource(details: FeatureRequestSource): boolean {
  return forProduct(desktopFeatures, currentProduct).some((feature) => feature.requests?.isSource(details) === true);
}

/** Host integration stays behind the feature registry public entry. */
export { notifyCapturePreferencesChanged, onCapturePreferencesChanged, saveCaptureShortcutPreference, bindCaptureForegroundShortcuts } from "./capture/preferences";
export { routeCaptureShortcut } from "./capture/shortcutRouting";
/** ACP 引擎只经公开入口消费同会话 CU 开关短指令，不得直达特性内部文件。 */
export { applyCuaCapabilityNotice } from "./computer-use/cuaSessionNotice";
