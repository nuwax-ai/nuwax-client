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
      setTemplateImage: vi.fn(),
    })),
    createFromPath: vi.fn().mockReturnValue({
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 22, height: 22 })),
      resize: vi.fn(function(this: any) { return this; }),
      setTemplateImage: vi.fn(),
    }),
    createFromDataURL: vi.fn().mockReturnValue({
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 16, height: 16 })),
      resize: vi.fn(function(this: any) { return this; }),
    }),
  },
  app: {
    getVersion: vi.fn(() => '0.7.4'),
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

import { TrayManager, TrayStatus, createTrayManager, setTrayUnreadCount } from './trayManager';
import { nativeImage, Menu } from 'electron';

describe('TrayManager', () => {
  let trayManager: TrayManager;
  const mockOptions = {
    onShowWindow: vi.fn(),
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

    it('Windows displays red 99+ digits, caches one image, and restores the original icon at zero', async () => {
      trayManager = new TrayManager({ ...mockOptions, platform: 'win32' });
      await trayManager.create();
      const tray = trayManager.getTray()!;
      const original = vi.mocked(nativeImage.createFromPath).mock.results[0].value;
      const menus = vi.mocked(Menu.buildFromTemplate).mock.calls.length;
      trayManager.setUnreadCount(100);
      const badge = vi.mocked(nativeImage.createFromBuffer).mock.results[0].value;
      expect(tray.setImage).toHaveBeenLastCalledWith(badge);
      trayManager.setUnreadCount(200);
      trayManager.setUnreadCount(10000);
      expect(nativeImage.createFromBuffer).toHaveBeenCalledOnce();
      expect(tray.setToolTip).toHaveBeenLastCalledWith(expect.stringContaining('10000 unread messages'));
      expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(menus);
      trayManager.updateServicesStatus(true);
      trayManager.refresh();
      expect(tray.setImage).toHaveBeenLastCalledWith(badge);
      expect(tray.setToolTip).toHaveBeenLastCalledWith(expect.stringContaining('Claw.Tray.Status.running'));
      expect(nativeImage.createFromBuffer).toHaveBeenCalledOnce();
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
