import React, { useEffect, useState } from 'react';
import { Button, Input, Space, Switch, message } from 'antd';
import { CAPTURE_HIDE_WINDOW_SETTING, CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING, DEFAULT_CAPTURE_SHORTCUT, DEFAULT_RECORD_SHORTCUT, captureShortcut, recordShortcut, displayCaptureShortcut, shortcutFromKeyboard } from '@shared/features/capture/preferences';

interface Props {
  settings?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
  t(key: string): string;
  disabled?: boolean;
  onShortcutChange?(shortcut: string): void;
  onRecordShortcutChange?(shortcut: string): void;
}
const saved = (result: unknown) => result !== false && !(result && typeof result === 'object' && 'success' in result && result.success === false);

export function CapturePreferences({ settings, t, disabled, onShortcutChange, onRecordShortcutChange }: Props) {
  const [hideWindow, setHideWindow] = useState(false);
  const [shortcut, setShortcut] = useState(DEFAULT_CAPTURE_SHORTCUT);
  const [draft, setDraft] = useState(DEFAULT_CAPTURE_SHORTCUT);
  const [recordKey, setRecordKey] = useState(DEFAULT_RECORD_SHORTCUT);
  const [recordDraft, setRecordDraft] = useState(DEFAULT_RECORD_SHORTCUT);
  const [ready, setReady] = useState(!settings);
  const [saving, setSaving] = useState(false);
  const mac = /mac/i.test(navigator.platform);
  const text = (key: string) => t(`Claw.Capture.${key}`);
  useEffect(() => {
    let alive = true;
    setReady(!settings);
    if (settings) void Promise.all([settings.get(CAPTURE_HIDE_WINDOW_SETTING), settings.get(CAPTURE_SHORTCUT_SETTING), settings.get(CAPTURE_RECORD_SHORTCUT_SETTING)])
      .then(([hide, value, record]) => {
        if (!alive) return;
        const next = captureShortcut(value);
        setHideWindow(hide === true); setShortcut(next); setDraft(next); onShortcutChange?.(next);
        const nextRecord = recordShortcut(record);
        setRecordKey(nextRecord); setRecordDraft(nextRecord); onRecordShortcutChange?.(nextRecord);
      }).catch(() => { if (alive) message.error(text('preferenceLoadFailed')); })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [settings, onShortcutChange, onRecordShortcutChange]);
  const save = async (key: string, value: boolean | string) => {
    if (!settings || saving) return;
    setSaving(true);
    try {
      if (!saved(await settings.set(key, value))) throw new Error('preference write failed');
      if (key === CAPTURE_HIDE_WINDOW_SETTING) setHideWindow(value === true);
      else if (key === CAPTURE_SHORTCUT_SETTING) { setShortcut(String(value)); setDraft(String(value)); onShortcutChange?.(String(value)); }
      else { setRecordKey(String(value)); setRecordDraft(String(value)); onRecordShortcutChange?.(String(value)); }
    } catch { message.error(text('preferenceSaveFailed')); }
    finally { setSaving(false); }
  };
  const locked = disabled || !ready || saving || !settings;
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Space><span>{text('hideAppWindow')}</span><Switch aria-label={text('hideAppWindow')}
      checked={hideWindow} disabled={locked} onChange={value => void save(CAPTURE_HIDE_WINDOW_SETTING, value)} /></Space>
    {[
      { key: CAPTURE_SHORTCUT_SETTING, label: 'shortcut', value: shortcut, draft, setDraft, fallback: DEFAULT_CAPTURE_SHORTCUT },
      { key: CAPTURE_RECORD_SHORTCUT_SETTING, label: 'recordShortcut', value: recordKey, draft: recordDraft, setDraft: setRecordDraft, fallback: DEFAULT_RECORD_SHORTCUT },
    ].map(entry => <Space direction="vertical" size={6} key={entry.key}>
      <Space wrap><span>{text(entry.label)}</span>
        <Input aria-label={text(entry.label)} readOnly value={displayCaptureShortcut(entry.draft, mac)} disabled={locked} style={{ width: 250 }}
          onKeyDown={event => {
            if (event.key === 'Tab') return;
            event.preventDefault();
            if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
            const next = shortcutFromKeyboard(event, mac);
            if (next) entry.setDraft(next); else message.error(text('shortcutInvalid'));
          }} />
        <Button disabled={locked || entry.draft === entry.value} onClick={() => void save(entry.key, entry.draft)}>{text('shortcutSave')}</Button>
        <Button disabled={locked || entry.value === entry.fallback} onClick={() => void save(entry.key, entry.fallback)}>{text('shortcutReset')}</Button>
      </Space>
    </Space>)}
    <span style={{ color: 'var(--color-text-secondary)' }}>{text('shortcutHint')}</span>
  </Space>;
}
