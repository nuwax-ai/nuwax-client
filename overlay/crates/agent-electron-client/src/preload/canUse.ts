import type { CompatibleHostBridge } from '@shared/types/hostBridge';
import { resolveHostCapability } from '@shared/hostCapabilities';

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
      if (capability.namespace === 'localFiles') {
        const caps = await bridge.localFiles?.getCapabilities?.();
        return caps?.available === true && await authorize(name) === true;
      }
      if (capability.namespace === 'capture') {
        const caps = await bridge.capture?.getCapabilities?.();
        if (!caps?.available) return false;
        const method = methods[0];
        const variant = capability.variant;
        if (method === 'screenshot' && (variant ? !caps.formats.still.some(format => format === variant) : !caps.formats.still.length)) return false;
        if (method === 'record' && (variant === 'gif' ? !caps.formats.gif : variant
          ? !caps.formats.video.some(format => format === variant) : !caps.formats.video.length && !caps.formats.gif)) return false;
        // 格式检查包含 await；再次授权，拒绝等待期间已换域/登出的文档。
        return await authorize(name) === true;
      }
      return true;
    } catch { return false; }
  };
}
