/**
 * 特性套件（_kit）的类型。
 *
 * 套件只含「一个特性接入客户端」所需的通用接缝：受信 IPC、生命周期、存储目录、设置、
 * 登录态、宿主窗口、进行中操作与 Agent。端口必须是通用的——不得为某个特性加专属字段
 * （边界检查 R5 强制）。静态注册，不做动态插件加载。
 */

import type { BrowserWindow, CommandLine, CustomScheme, OnBeforeRequestListenerDetails } from "electron";
import type { FeatureActivities } from "./activities";
import type { AgentSessionParticipant } from "./agentSessions";
import type { FeatureLifecycle } from "./lifecycle";
import type { ScratchDir } from "./scratchDir";
import type { TrustedIpc } from "./trustedIpc";

export interface FeatureLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface FeatureHandle {
  dispose(): void | Promise<void>;
}

export interface FeatureWorkspaceServices {
  getIdentity(): { sandboxId: string; businessOrigins: string[] } | null;
  resolveRoot(input: { cId: string; workspacePath?: string; projectId?: string; serviceType?: string; userId?: string }): string | null | Promise<string | null>;
  getFileServerPort(): number;
  isCurrentDocument(event: unknown): boolean;
}

/** 本机设置（客户端设置库）。写入返回是否落库成功。 */
export interface FeatureSettings {
  read(key: string): unknown;
  write(key: string, value: unknown): boolean;
}

export interface FeatureSession {
  /** 当前是否持有有效登录（商业版 ticket）。 */
  isAuthenticated(): boolean;
}

export interface FeatureWindows {
  /** 宿主主窗口；未创建或已销毁时为 null。 */
  getMain(): BrowserWindow | null;
}

/** 本地 MCP 条目（与客户端 `mcp_local_config` 的条目形状一致）。 */
export interface FeatureMcpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  allowTools?: string[];
  denyTools?: string[];
}

export interface FeatureAgent {
  /** Resolve the business conversation of a host-owned native session; ambiguity returns null. */
  resolveConversationId?(sessionId: string): string | null;
  /** 登记（entry）或移除（null）本地 MCP 条目，并同步到运行中的 MCP Proxy。 */
  setLocalMcpServer(id: string, entry: FeatureMcpServerEntry | null): Promise<void>;
  hasLocalMcpServer(id: string): boolean;
  /** 随包 Node 运行时路径；不可用时为 null。 */
  resolveNodeBinary(): string | null;
  /** 在 Agent 引擎的会话生命周期上挂接；每个引擎各自调用一次工厂。 */
  registerSessionParticipant(factory: () => AgentSessionParticipant): () => void;
}

export interface FeaturePermissionServices {
  openGuide(target: "screen_recording" | "file_access"): boolean;
  onFileAccessError(error: unknown, stillCurrent: () => boolean): Promise<void>;
  /** An external permission subject keeps its own identity and request boundary. */
  registerExternalSubject?(subject: {
    enabled?(): boolean | Promise<boolean>;
    check(): Promise<{ accessibility: "granted" | "denied" | "unknown"; screen_recording: "granted" | "denied" | "unknown" }>;
    request(key: "accessibility" | "screen_recording"): Promise<boolean>;
    appPath(): string | null;
  }): () => void;
}

export interface FeatureContext {
  /** 宿主产品标识（如 `nuwax`）。特性不应自行判断产品，门控看清单的 `products`。 */
  product: string;
  /** 面向业务页（受信顶层文档）的 IPC：sender 必须是当前受信的顶层业务文档。 */
  ipc: TrustedIpc;
  /** 面向宿主壳渲染进程（如「关于」「设置」页）的 IPC：sender 必须是宿主壳。 */
  hostIpc: TrustedIpc;
  lifecycle: FeatureLifecycle;
  /** 该特性专属的临时目录（`~/.nuwax/<id>/` 下带 TTL 的子目录），仅限本特性使用。 */
  scratch: ScratchDir;
  /** 该特性专属的持久目录（`~/.nuwax/<id>`），目录内布局由特性自管。 */
  dataDir: string;
  log: FeatureLogger;
  /** 本轮调用时使用宿主当前语言；未注入时由特性选择默认文案。 */
  translate?(key: string): string;
  settings: FeatureSettings;
  session: FeatureSession;
  windows: FeatureWindows;
  activities: FeatureActivities;
  agent: FeatureAgent;
  workspace?: FeatureWorkspaceServices;
  permissions?: FeaturePermissionServices;
}

export interface FeatureBridgeDeclaration {
  /** 本特性实现的 `NuwaClawBridge` 命名空间；canUse 对它们要求本特性已注册且开关仍开。 */
  namespaces: readonly string[];
  /** 主进程侧的额外判定（如平台不支持某种复制）。 */
  canUse?(capability: string): boolean;
}

export type FeatureRequestSource = Pick<
  OnBeforeRequestListenerDetails,
  "frame" | "referrer" | "webContents" | "webContentsId"
>;

export interface FeatureRequestPolicy {
  /** 唯一请求门的判定：true 放行、false 拒绝、undefined 不属于本特性。 */
  authorize(details: OnBeforeRequestListenerDetails): boolean | undefined;
  /** 请求是否源自本特性授予的内容（凭据过滤用）。 */
  isSource(details: FeatureRequestSource): boolean;
}

export interface DesktopFeature {
  id: string;
  /** 允许加载该特性的宿主产品；不在列表内则整个特性不存在（零痕迹）。 */
  products: readonly string[];
  /** 构建期默认开关；运行期可被设置项 `features.<id>.enabled` 覆盖。 */
  enabledByDefault: boolean;
  /** 发版强关原因：非空时忽略设置覆盖，视同关闭。 */
  lockedOff?: string;
  /** 仅启动前声明；handler 仍由运行期开关控制。 */
  schemes?: readonly CustomScheme[];
  /** app ready 之前的命令行准备（按产品过滤，与开关无关）。 */
  beforeReady?(commandLine: CommandLine): void;
  bridge?: FeatureBridgeDeclaration;
  /** 按产品过滤、与注册与否无关：关闭时仍需拒绝本特性的协议请求。 */
  requests?: FeatureRequestPolicy;
  /** 本特性保留的本地 MCP 条目 id；特性未启用时宿主清理残留并在会话中剥离。 */
  agentServers?: readonly string[];
  /** 同步且轻量；重活必须懒初始化，不得拖慢启动。 */
  register(ctx: FeatureContext): FeatureHandle;
}
