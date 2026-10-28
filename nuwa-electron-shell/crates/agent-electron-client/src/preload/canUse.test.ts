import { describe, expect, it, vi } from 'vitest';
import type { CaptureCapabilities, CompatibleHostBridge } from '@shared/types/hostBridge';
import { createCanUse } from './canUse';

const caps = { available: true, permission: 'denied', formats: { still: ['png', 'jpeg'], video: ['mp4'], gif: true } } as CaptureCapabilities;
function fixture(value = caps) {
  const authorize = vi.fn(async () => true);
  const capture = { getCapabilities: vi.fn(async () => value), screenshot: vi.fn(), record: vi.fn(), copy: vi.fn() };
  const bridge: CompatibleHostBridge = { capture, native: { openWindow: vi.fn() }, auth: { getToken: vi.fn(), persistToken: vi.fn() } };
  return { authorize, capture, bridge, canUse: createCanUse(bridge, authorize) };
}
describe('canUse 无副作用的能力探测', () => {
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
});
