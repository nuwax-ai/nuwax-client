/**
 * 特性注册：按「产品 + 开关」过滤后依次注册，统一释放。
 *
 * - 不在 `products` 内、或被关闭的特性：`register` 与 `createContext` 都**不会被调用**
 *   （关闭即零痕迹：不注册 IPC、不建临时目录、不监听任何事件）；
 * - 单个特性注册抛错只记录日志并跳过，不影响客户端启动与其他特性。
 */

import type { DesktopFeature, FeatureContext, FeatureHandle, FeatureLogger } from "./types";

export interface RegisterDeps {
  product: string;
  /** 运行期开关：返回该特性是否启用（通常 = 设置项覆盖 ?? 清单默认值）。 */
  isEnabled(featureId: string, enabledByDefault: boolean): boolean;
  createContext(feature: DesktopFeature): FeatureContext;
  log: FeatureLogger;
}

export interface RegisteredFeatures {
  readonly ids: readonly string[];
  dispose(): Promise<void>;
}

export function registerDesktopFeatures(
  features: readonly DesktopFeature[],
  deps: RegisterDeps,
): RegisteredFeatures {
  const seen = new Set<string>();
  for (const feature of features) {
    if (seen.has(feature.id)) {
      throw new Error(`Duplicate desktop feature id: ${feature.id}`);
    }
    seen.add(feature.id);
  }

  const handles: Array<{ id: string; handle: FeatureHandle }> = [];

  for (const feature of features) {
    if (!feature.products.includes(deps.product)) continue;
    let enabled: boolean;
    try {
      enabled = deps.isEnabled(feature.id, feature.enabledByDefault);
    } catch (error) {
      // 读开关失败（如设置库尚未就绪）：回落到清单默认值，不能连累其他特性
      deps.log.warn(`[Features] ${feature.id} enable check failed, using default`, error);
      enabled = feature.enabledByDefault;
    }
    if (!enabled) {
      deps.log.info(`[Features] ${feature.id} disabled`);
      continue;
    }
    try {
      const handle = feature.register(deps.createContext(feature));
      handles.push({ id: feature.id, handle });
      deps.log.info(`[Features] ${feature.id} registered`);
    } catch (error) {
      deps.log.error(`[Features] ${feature.id} failed to register, skipped`, error);
    }
  }

  return {
    ids: handles.map((h) => h.id),
    async dispose() {
      for (const { id, handle } of [...handles].reverse()) {
        try {
          await handle.dispose();
        } catch (error) {
          deps.log.error(`[Features] ${id} failed to dispose`, error);
        }
      }
      handles.length = 0;
    },
  };
}
