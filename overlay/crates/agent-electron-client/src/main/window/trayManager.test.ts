/**
 * 单元测试: TrayManager
 *
 * 测试托盘管理器逻辑（Electron API 被 mock）
 *
 * 注意：由于 TrayManager 依赖 Electron 的 Tray/nativeImage 等 API，
 * 这些测试主要验证状态更新和菜单构建逻辑。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const state = vi.hoisted(() => ({ packaged: false }));

// 在导入模块前设置 mock
vi.mock('electron', () => ({
  Tray: vi.fn().mockImplementation(() => ({
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
    setImage: vi.fn(),
    setTitle: vi.fn(),
  })),
  nativeImage: {
    createFromBuffer: vi.fn().mockImplementation(() => ({
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 16, height: 16 })),
      resize: vi.fn(function(this: any) { return this; }),
      addRepresentation: vi.fn(),
      setTemplateImage: vi.fn(),
    })),
    createFromPath: vi.fn().mockReturnValue({
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 64, height: 64 })),
      crop: vi.fn(function(this: any) { return this; }),
      resize: vi.fn(function(this: any) { return this; }),
      addRepresentation: vi.fn(),
      toBitmap: vi.fn((options?: { scaleFactor?: number }) => {
        const size = options?.scaleFactor === 2 ? 32 : 16;
        return Buffer.from(Array(size * size).fill([20, 40, 60, 255]).flat());
      }),
      toDataURL: vi.fn(() => 'data:image/png;base64,retina'),
      setTemplateImage: vi.fn(),
    }),
    createFromBitmap: vi.fn().mockImplementation(() => ({
      isEmpty: vi.fn(() => false),
      addRepresentation: vi.fn(),
      toDataURL: vi.fn(() => 'data:image/png;base64,badge-retina'),
    })),
    createFromDataURL: vi.fn().mockReturnValue({
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 16, height: 16 })),
      resize: vi.fn(function(this: any) { return this; }),
    }),
  },
  app: {
    getVersion: vi.fn(() => '0.7.4'),
    getAppPath: vi.fn(() => '/development/client'),
    get isPackaged() { return state.packaged; },
    dock: {
      show: vi.fn(),
    },
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({})),
  },
  dialog: {
    showErrorBox: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
  dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
}));

vi.mock('./autoLaunchManager', () => ({
  createAutoLaunchManager: vi.fn(() => ({
    isEnabled: vi.fn().mockResolvedValue(false),
    setEnabled: vi.fn().mockResolvedValue(true),
  })),
}));
vi.mock('../services/i18n', () => ({
  t: (key: string, count?: string) => count === undefined ? key : `${count} unread messages`,
}));

const activityState = vi.hoisted(() => ({
  entries: [] as Array<{ featureId: string; activity: { actions: Array<{ id: string; labelKey: string; run(): void }> } }>,
  listener: undefined as ((entries: any[]) => void) | undefined,
}));
vi.mock('../features', () => ({
  desktopFeatureActivities: () => activityState.entries,
  onDesktopFeatureActivitiesChanged: (fn: (entries: any[]) => void) => {
    activityState.listener = fn;
    return () => {};
  },
}));

import { TrayManager, TrayStatus, createTrayManager, setTrayUnreadCount } from './trayManager';
import { nativeImage, Menu } from 'electron';

describe('TrayManager', () => {
  let trayManager: TrayManager;
  const mockOptions = {
    onShowWindow: vi.fn(),
    onOpenSettings: vi.fn(),
    onRestartServices: vi.fn().mockResolvedValue(undefined),
    onStopServices: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.packaged = false;
    setTrayUnreadCount(0);
    trayManager = new TrayManager(mockOptions);
  });

  afterEach(() => {
    trayManager.destroy();
  });

  describe('初始化', () => {
    it('should create TrayManager instance', () => {
      expect(trayManager).toBeDefined();
    });
  });

  it('开发托盘图标从应用根目录读取，兼容 esbuild 和独立应用启动', async () => {
    await trayManager.create();
    expect(nativeImage.createFromPath).toHaveBeenCalledWith('/development/client/public/tray/tray@2x.png');
  });

  it.each(['darwin', 'win32', 'linux'] as const)('托盘设置入口在 %s 调用打开设置动作', async platform => {
    trayManager = new TrayManager({ ...mockOptions, platform });
    await trayManager.create();
    const items = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0];
    const settings = items.find(item => item.label === 'Claw.Menu.settings');
    expect(settings).toBeDefined(); settings!.click!({} as never, {} as never, {} as never);
    expect(mockOptions.onOpenSettings).toHaveBeenCalledOnce();
    expect(mockOptions.onShowWindow).not.toHaveBeenCalled();
  });

  it('进行中操作渲染为托盘动作项，按特性顺序展示，清除后移除', async () => {
    await trayManager.create();
    const pause = vi.fn(), stop = vi.fn(), cuaStop = vi.fn();
    activityState.entries = [
      { featureId: 'computer-use', activity: { actions: [{ id: 'stop', labelKey: 'Claw.Cua.stop', run: cuaStop }] } },
      { featureId: 'capture', activity: { actions: [
        { id: 'pause', labelKey: 'Claw.Capture.pause', run: pause },
        { id: 'stop', labelKey: 'Claw.Capture.stopRecording', run: stop },
      ] } },
    ];
    activityState.listener!(activityState.entries);
    const current = () => vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0];
    // 展示顺序 = 特性登记顺序
    const labels = current().map(item => item.label);
    expect(labels.indexOf('Claw.Cua.stop')).toBeLessThan(labels.indexOf('Claw.Capture.pause'));
    const pauseItem = current().find(item => item.label === 'Claw.Capture.pause');
    expect(pauseItem).toBeDefined(); pauseItem!.click!({} as never, {} as never, {} as never);
    expect(pause).toHaveBeenCalledOnce();
    activityState.entries = [
      { featureId: 'capture', activity: { actions: [
        { id: 'pause', labelKey: 'Claw.Capture.resume', run: pause },
        { id: 'stop', labelKey: 'Claw.Capture.stopRecording', run: stop },
      ] } },
    ];
    activityState.listener!(activityState.entries);
    expect(current().some(item => item.label === 'Claw.Capture.pause')).toBe(false);
    expect(current().some(item => item.label === 'Claw.Capture.resume')).toBe(true);
    const stopItem = current().find(item => item.label === 'Claw.Capture.stopRecording');
    stopItem!.click!({} as never, {} as never, {} as never); expect(stop).toHaveBeenCalledOnce();
    const cuaItem = current().find(item => item.label === 'Claw.Cua.stop');
    expect(cuaItem).toBeUndefined();
    activityState.entries = [];
    activityState.listener!(activityState.entries);
    expect(current().some(item => String(item.label).startsWith('Claw.Capture.'))).toBe(false);
    expect(current().some(item => item.label === 'Claw.Cua.stop')).toBe(false);
  });

  describe('create()', () => {
    it('should create tray and return void', async () => {
      const result = await trayManager.create();
      expect(result).toBeUndefined();
    });
  });

  describe('updateServicesStatus()', () => {
    it('should update status to running', async () => {
      await trayManager.create();
      // 不应抛出错误
      expect(() => trayManager.updateServicesStatus(true)).not.toThrow();
    });

    it('should update status to stopped', async () => {
      await trayManager.create();
      expect(() => trayManager.updateServicesStatus(false)).not.toThrow();
    });
  });

  describe('setStatus()', () => {
    it('should set error status', async () => {
      await trayManager.create();
      expect(() => trayManager.setStatus('error')).not.toThrow();
    });

    it('should set starting status', async () => {
      await trayManager.create();
      expect(() => trayManager.setStatus('starting')).not.toThrow();
    });

    it('should set running status', async () => {
      await trayManager.create();
      expect(() => trayManager.setStatus('running')).not.toThrow();
    });

    it('should set stopped status', async () => {
      await trayManager.create();
      expect(() => trayManager.setStatus('stopped')).not.toThrow();
    });
  });

  describe('destroy()', () => {
    it('should destroy tray without error', () => {
      expect(() => trayManager.destroy()).not.toThrow();
    });
  });

  describe('getTray()', () => {
    it('should return null before create', () => {
      expect(trayManager.getTray()).toBeNull();
    });
  });

  describe('系统未读角标', () => {
    it('macOS keeps the template icon and displays count at its right, capping at 99+', async () => {
      state.packaged = true;
      trayManager = new TrayManager({ ...mockOptions, platform: 'darwin' });
      await trayManager.create();
      const tray = trayManager.getTray()!;
      const original = vi.mocked(nativeImage.createFromPath).mock.results[0].value;
      expect(original.setTemplateImage).toHaveBeenCalledWith(true);
      trayManager.setUnreadCount(102);
      expect(tray.setImage).toHaveBeenLastCalledWith(original);
      expect(tray.setTitle).toHaveBeenLastCalledWith('99+', { fontType: 'monospacedDigit' });
      expect(tray.setToolTip).toHaveBeenLastCalledWith(expect.stringContaining('102 unread messages'));
      trayManager.setUnreadCount(0);
      expect(tray.setTitle).toHaveBeenLastCalledWith('', { fontType: 'monospacedDigit' });
      expect(tray.setImage).toHaveBeenLastCalledWith(original);
      expect(nativeImage.createFromBuffer).not.toHaveBeenCalled();
    });

    it('Windows keeps the app icon beneath the unread badge and restores it at zero', async () => {
      trayManager = new TrayManager({ ...mockOptions, platform: 'win32' });
      await trayManager.create();
      const tray = trayManager.getTray()!;
      const original = vi.mocked(nativeImage.createFromPath).mock.results[0].value;
      expect(original.crop).toHaveBeenCalledWith({ x: 6, y: 6, width: 52, height: 52 });
      expect(original.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
      expect(original.resize).toHaveBeenCalledWith({ width: 32, height: 32 });
      expect(original.addRepresentation).toHaveBeenCalledWith({
        scaleFactor: 2,
        dataURL: 'data:image/png;base64,retina',
      });
      const menus = vi.mocked(Menu.buildFromTemplate).mock.calls.length;
      trayManager.setUnreadCount(100);
      const badge = vi.mocked(nativeImage.createFromBitmap).mock.results[0].value;
      const bitmap1x = vi.mocked(nativeImage.createFromBitmap).mock.calls[0][0];
      const bitmap2x = vi.mocked(nativeImage.createFromBitmap).mock.calls[1][0];
      expect(vi.mocked(nativeImage.createFromBitmap).mock.calls.map(([, options]) => options)).toEqual([
        { width: 16, height: 16 },
        { width: 32, height: 32 },
      ]);
      expect(bitmap1x.subarray((15 * 16) * 4, (15 * 16) * 4 + 4)).toEqual(Buffer.from([20, 40, 60, 255]));
      expect(bitmap1x.subarray((4 * 16 + 15) * 4, (4 * 16 + 16) * 4)).toEqual(Buffer.from([57, 41, 230, 255]));
      expect(bitmap2x.subarray((31 * 32) * 4, (31 * 32) * 4 + 4)).toEqual(Buffer.from([20, 40, 60, 255]));
      expect(badge.addRepresentation).toHaveBeenCalledWith({
        scaleFactor: 2,
        dataURL: 'data:image/png;base64,badge-retina',
      });
      expect(tray.setImage).toHaveBeenLastCalledWith(badge);
      trayManager.setUnreadCount(200);
      trayManager.setUnreadCount(10000);
      expect(nativeImage.createFromBitmap).toHaveBeenCalledTimes(2);
      expect(tray.setToolTip).toHaveBeenLastCalledWith(expect.stringContaining('10000 unread messages'));
      expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(menus);
      trayManager.updateServicesStatus(true);
      trayManager.refresh();
      expect(tray.setImage).toHaveBeenLastCalledWith(badge);
      expect(tray.setToolTip).toHaveBeenLastCalledWith(expect.stringContaining('Claw.Tray.Status.running'));
      expect(nativeImage.createFromBitmap).toHaveBeenCalledTimes(2);
      trayManager.setUnreadCount(0);
      expect(tray.setImage).toHaveBeenLastCalledWith(original);
    });

    it('reapplies cached count when an initially absent tray is created or replaced', async () => {
      setTrayUnreadCount(7);
      trayManager = createTrayManager({ ...mockOptions, platform: 'darwin' });
      await trayManager.create();
      const first = trayManager.getTray()!;
      expect(first.setTitle).toHaveBeenLastCalledWith('7', { fontType: 'monospacedDigit' });
      trayManager = createTrayManager({ ...mockOptions, platform: 'darwin' });
      await trayManager.create();
      expect(first.destroy).toHaveBeenCalledOnce();
      expect(trayManager.getTray()!.setTitle).toHaveBeenLastCalledWith('7', { fontType: 'monospacedDigit' });
      setTrayUnreadCount(0);
      expect(trayManager.getTray()!.setTitle).toHaveBeenLastCalledWith('', { fontType: 'monospacedDigit' });
    });

    it('restores count after disable/recreate without duplicate tray handles or click listeners', async () => {
      trayManager = new TrayManager({ ...mockOptions, platform: 'darwin' });
      trayManager.setUnreadCount(12);
      await trayManager.create();
      const first = trayManager.getTray()!;
      const listeners = vi.mocked(first.on).mock.calls as unknown as Array<[string, () => void]>;
      const click = listeners.find(([event]) => event === 'click')![1];
      click();
      expect(mockOptions.onShowWindow).toHaveBeenCalledOnce();
      await trayManager.create();
      expect(first.on).toHaveBeenCalledTimes(2);
      trayManager.destroy();
      await trayManager.create();
      const second = trayManager.getTray()!;
      expect(second).not.toBe(first);
      expect(second.setTitle).toHaveBeenLastCalledWith('12', { fontType: 'monospacedDigit' });
      expect(second.on).toHaveBeenCalledTimes(2);
    });
  });
});

describe('TrayStatus 类型', () => {
  it('should have correct status values', () => {
    const statuses: TrayStatus[] = ['running', 'stopped', 'error', 'starting'];
    expect(statuses).toHaveLength(4);
  });
});
