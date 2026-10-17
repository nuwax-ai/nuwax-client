/**
 * 特性套件（_kit）的类型。
 *
 * 套件只含「一个特性接入客户端」所需的最小接缝：受信 IPC、生命周期事件、临时目录。
 * 第二个特性出现、确有新需求时再增补，不预建平台。静态注册，不做动态插件加载。
 */

import type { CustomScheme } from "electron";
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

export interface FeaturePermissionServices {
  openGuide(target: "screen_recording" | "file_access"): boolean;
  onFileAccessError(error: unknown, stillCurrent: () => boolean): Promise<void>;
}

export interface FeatureContext {
  /** 宿主产品标识（如 `nuwax`）。特性不应自行判断产品，门控看清单的 `products`。 */
  product: string;
  /** 面向业务页（受信顶层文档）的 IPC：sender 必须是当前受信的顶层业务文档。 */
  ipc: TrustedIpc;
  /** 面向宿主壳渲染进程（如「关于」页）的 IPC：sender 必须是宿主壳。 */
  hostIpc: TrustedIpc;
  lifecycle: FeatureLifecycle;
  /** 该特性专属的临时目录（`~/.nuwax/<id>/`），仅限本特性使用。 */
  scratch: ScratchDir;
  log: FeatureLogger;
  /** 本轮调用时使用宿主当前语言；未注入时由特性选择默认文案。 */
  translate?(key: string): string;
  /** 只读本机偏好，由宿主注入；特性不直接访问客户端数据库。 */
  getSetting?(key: string): unknown;
  workspace?: FeatureWorkspaceServices;
  permissions?: FeaturePermissionServices;
  setRecordingStopAction?(action: (() => void) | null): void;
  setRecordingPauseAction?(action: (() => void) | null, paused: boolean): void;
}

export interface DesktopFeature {
  id: string;
  /** 允许加载该特性的宿主产品；不在列表内则整个特性不存在（零痕迹）。 */
  products: readonly string[];
  /** 构建期默认开关；运行期可被设置项 `features.<id>.enabled` 覆盖。 */
  enabledByDefault: boolean;
  /** 仅启动前声明；handler 仍由运行期开关控制。 */
  schemes?: readonly CustomScheme[];
  /** 同步且轻量；重活必须懒初始化，不得拖慢启动。 */
  register(ctx: FeatureContext): FeatureHandle;
}
