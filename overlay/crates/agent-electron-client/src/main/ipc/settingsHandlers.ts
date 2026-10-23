import { ipcMain } from 'electron';
import { getDb, readSetting } from '../db';
import log from 'electron-log';
import { readQuickInitConfig } from '../bootstrap/quickInit';
import { DORMANCY_SETTING_KEY, refreshHostActivity } from '../services/hostActivity';
import { APP_NAME_IDENTIFIER } from '@shared/constants';
import { CAPTURE_HIDE_WINDOW_SETTING, CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING, captureShortcut, recordShortcut, parseCaptureShortcut } from '@shared/features/capture/preferences';
import { notifyCapturePreferencesChanged } from '../features/capture/preferences';
import { sanitizeCommercialPortSetting, projectCommercialPortSetting, AUTOMATIC_PORTS_KEY, AUTOMATIC_PORTS_MIGRATED_KEY } from '../services/commercialLocalPorts';

export function registerSettingsHandlers(): void {
  // Settings
  ipcMain.handle('settings:get', (_, key: string) => {
    const db = getDb();
    if (!db) return null;
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return projectCommercialPortSetting(key, row ? JSON.parse(row.value) : null);
  });

  ipcMain.handle('settings:set', (_, key: string, value: unknown) => {
    if ([CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING].includes(key)) {
      const shortcut = value == null ? (key === CAPTURE_SHORTCUT_SETTING ? captureShortcut(null) : recordShortcut(null)) : parseCaptureShortcut(value);
      if (!shortcut) return false;
      const other = key === CAPTURE_SHORTCUT_SETTING ? recordShortcut(readSetting(CAPTURE_RECORD_SHORTCUT_SETTING)) : captureShortcut(readSetting(CAPTURE_SHORTCUT_SETTING));
      if (shortcut === other) return false;
      value = shortcut;
    }
    if (key === CAPTURE_HIDE_WINDOW_SETTING && value != null && typeof value !== 'boolean') return false;
    if (APP_NAME_IDENTIFIER === 'nuwax' && [AUTOMATIC_PORTS_KEY, AUTOMATIC_PORTS_MIGRATED_KEY].includes(key)) return false;
    value = sanitizeCommercialPortSetting(key, value);
    const db = getDb();
    if (!db) return false;
    if (value === null || value === undefined) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
      );
      stmt.run(key, JSON.stringify(value));
    }
    if (key === DORMANCY_SETTING_KEY) {
      try {
        refreshHostActivity();
      } catch (error) {
        log.warn('[Settings] Host activity refresh failed after saving dormancy setting', error);
      }
    }
    if ([CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING].includes(key)) notifyCapturePreferencesChanged();
    return true;
  });

  // Mirror / Registry — 动态切换 npm、uv 镜像源
  ipcMain.handle('mirror:get', async () => {
    const { getMirrorConfig, MIRROR_PRESETS } = await import('../services/system/dependencies');
    return { success: true, ...getMirrorConfig(), presets: MIRROR_PRESETS };
  });

  ipcMain.handle('mirror:set', async (_, config: { npmRegistry?: string; uvIndexUrl?: string }) => {
    const { setMirrorConfig, getMirrorConfig } = await import('../services/system/dependencies');
    try {
      setMirrorConfig(config);
      // 持久化到 SQLite
      const db = getDb();
      if (db) {
        const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        stmt.run('mirror_config', JSON.stringify(getMirrorConfig()));
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Quick Init — 读取 ~/.nuwaclaw/nuwaclaw.json 快捷配置
  ipcMain.handle('quickInit:getConfig', () => {
    const config = readQuickInitConfig();
    return sanitizeCommercialPortSetting('step1_config', config);
  });
}
