import { describe, expect, it, vi } from 'vitest';
import type { CaptureCapabilities, CompatibleHostBridge, HostThemesState } from '@shared/types/hostBridge';
import { createCanUse } from './canUse';

const caps = { available: true, permission: 'denied', formats: { still: ['png', 'jpeg'], video: ['mp4'], gif: true } } as CaptureCapabilities;
function fixture(value = caps) {
  const authorize = vi.fn(async () => true);
  const capture = { getCapabilities: vi.fn(async () => value), screenshot: vi.fn(), record: vi.fn(), copy: vi.fn() };
  const bridge: CompatibleHostBridge = { capture, native: { openWindow: vi.fn() }, auth: { getToken: vi.fn(), persistToken: vi.fn() } };
  return { authorize, capture, bridge, canUse: createCanUse(bridge, authorize) };
}
describe('canUse 文档授权和能力探测', () => {
  it('无桥、未知能力、原型键、退休 token 与缺失方法都返回 false', async () => {
    const f = fixture();
    for (const name of ['constructor', '__proto__', 'capture.toString', 'capture.screenshot.png.extra', 'Capture', 'auth.getToken', 'auth.persistToken', 'native.saveFile']) {
      expect(await f.canUse(name)).toBe(false);
    }
    expect(await createCanUse({}, f.authorize)('capture')).toBe(false);
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('按当前格式区分 PNG、JPEG、MP4、GIF 和缺编码器，探测不调用采集', async () => {
    const f = fixture();
    for (const name of ['capture', 'capture.screenshot', 'capture.screenshot.png', 'capture.screenshot.jpeg', 'capture.record.mp4', 'capture.record.gif', 'capture.copy.file']) expect(await f.canUse(name)).toBe(true);
    for (const name of ['capture.screenshot.webp', 'capture.record.webm']) expect(await f.canUse(name)).toBe(false);
    expect(f.capture.screenshot).not.toHaveBeenCalled(); expect(f.capture.record).not.toHaveBeenCalled(); expect(f.capture.copy).not.toHaveBeenCalled();
  });
  it('未授权、关闭特性和查询错误保守返回 false', async () => {
    const f = fixture(); f.authorize.mockResolvedValue(false);
    expect(await f.canUse('native')).toBe(false); expect(await f.canUse('capture')).toBe(false);
    expect(f.capture.getCapabilities).not.toHaveBeenCalled();
    f.authorize.mockRejectedValue(new Error('No handler registered'));
    expect(await f.canUse('native.openWindow')).toBe(false);
    expect(await fixture({ ...caps, available: false }).canUse('capture')).toBe(false);
  });
  it('查询格式期间登录代次失效时重新检查，不缓存 true', async () => {
    const f = fixture(); f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await f.canUse('capture.record.mp4')).toBe(false);
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it('旧 bridge 可缺复制；组探测至少有一个成员，perf 遵循运行时开关', async () => {
    const f = fixture(); delete f.bridge.capture!.copy;
    expect(await f.canUse('capture')).toBe(true); expect(await f.canUse('capture.copy.image')).toBe(false);
    expect(await f.canUse('native')).toBe(true);
    f.bridge.perf = { enabled: () => false, mark: vi.fn() };
    expect(await f.canUse('perf.mark')).toBe(false);
  });
  it('本地文件访问复用实时能力与代次，探测不列文件或创建授权上下文', async () => {
    const f = fixture(); const getCapabilities = vi.fn(async () => ({ apiVersion: 1, available: false }));
    const listFiles = vi.fn(), resolveContext = vi.fn();
    f.bridge.localFiles = { getCapabilities, listFiles, resolveContext };
    expect(await f.canUse('localFiles.listFiles')).toBe(false);
    getCapabilities.mockResolvedValue({ apiVersion: 1, available: true });
    expect(await f.canUse('localFiles.listFiles')).toBe(true);
    expect(await f.canUse('localFiles.resolveContext')).toBe(true);
    expect(await f.canUse('localFiles.nonexistent')).toBe(false);
    expect(listFiles).not.toHaveBeenCalled(); expect(resolveContext).not.toHaveBeenCalled();
    f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await f.canUse('localFiles.listFiles')).toBe(false);
  });
  it('主题在页面启动时先登记受信文档，再读取快照并检查当前代次', async () => {
    let registered = false;
    const order: string[] = [];
    const getContext = vi.fn(async () => {
      order.push('context');
      registered = true;
      return { businessOrigin: 'https://business.example', gatewayOrigin: null, loadMode: 'direct' as const };
    });
    const getState = vi.fn(async () => {
      order.push('snapshot');
      return { revision: 4 } as HostThemesState;
    });
    const authorize = vi.fn(async () => {
      order.push('authorize');
      return registered;
    });
    const bridge: CompatibleHostBridge = { auth: { getContext }, themes: { getState } };
    expect(await createCanUse(bridge, authorize)('themes')).toBe(true);
    expect(order).toEqual(['context', 'authorize', 'snapshot', 'authorize']);
    expect(getContext).toHaveBeenCalledTimes(1);
  });
  it('主题文档登记失败时拒绝能力，不读取快照或绕过授权', async () => {
    const getContext = vi.fn(async () => null);
    const getState = vi.fn();
    const authorize = vi.fn(async () => true);
    const bridge: CompatibleHostBridge = { auth: { getContext }, themes: { getState } };
    const canUse = createCanUse(bridge, authorize);
    expect(await canUse('themes')).toBe(false);
    getContext.mockRejectedValueOnce(new Error('Context unavailable'));
    expect(await canUse('themes.getState')).toBe(false);
    expect(getState).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
  it('主题快照读取期间授权失效时仍拒绝，也不为其他能力登记文档', async () => {
    const f = fixture();
    const getContext = vi.fn(async () => ({ businessOrigin: 'https://business.example', gatewayOrigin: null, loadMode: 'direct' as const }));
    f.bridge.auth = { getContext };
    f.bridge.themes = { getState: vi.fn(async () => ({ revision: 2 } as HostThemesState)) };
    expect(await f.canUse('capture')).toBe(true);
    expect(getContext).not.toHaveBeenCalled();
    f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await f.canUse('themes')).toBe(false);
    expect(getContext).toHaveBeenCalledTimes(1);
  });
});
