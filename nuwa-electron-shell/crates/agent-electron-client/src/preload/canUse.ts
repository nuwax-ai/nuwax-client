import type { CompatibleHostBridge } from '@shared/types/hostBridge';
import { resolveHostCapability } from '@shared/hostCapabilities';
import { probeFeatureCapability } from './features';

/** 每次探测读取当前文档授权和实时格式，不缓存到导航或登录边界之外。 */
export function createCanUse(bridge: CompatibleHostBridge, authorize: (name: string) => Promise<boolean>) {
  return async (name: string): Promise<boolean> => {
    const capability = resolveHostCapability(name);
    if (!capability) return false;
    try {
      const namespace = bridge[capability.namespace];
      if (!namespace) return false;
      const methods = capability.methods.filter(method => typeof (namespace as Record<string, unknown>)[method] === 'function');
      if (!methods.length || await authorize(name) !== true) return false;
      if (capability.namespace === 'perf') return bridge.perf?.enabled?.() === true;
      // 特性归属的命名空间由各特性 preload 探测（可用性/格式），之后仍需通用流程放行。
      const probed = await probeFeatureCapability(
        capability.namespace, { methods, variant: capability.variant }, name, bridge, authorize);
      if (probed !== null) return probed;
      return true;
    } catch { return false; }
  };
}
