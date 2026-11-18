import React, { useEffect, useState } from "react";
import { Switch, message } from "antd";
import { I18N_KEYS } from "@shared/constants";
import { UPDATE_AUTO_DOWNLOAD_SETTING_KEY } from "@shared/types/updateTypes";

export function AutoDownloadUpdateSettings({
  t,
  Row,
}: {
  t: (key: string) => string;
  Row: React.ComponentType<{
    label: React.ReactNode;
    desc?: React.ReactNode;
    control?: React.ReactNode;
  }>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!window.electronAPI?.settings?.get)
          throw new Error("Settings unavailable");
        const value = await window.electronAPI.settings.get(
          UPDATE_AUTO_DOWNLOAD_SETTING_KEY,
        );
        if (!active) return;
        setEnabled(value === true);
        setReady(true);
      } catch {
        if (active) message.error(t(I18N_KEYS.Toast.ERROR.LOAD_FAILED));
      }
    })();
    return () => {
      active = false;
    };
  }, [t]);

  const change = async (checked: boolean) => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const saved = await window.electronAPI?.settings?.set(
        UPDATE_AUTO_DOWNLOAD_SETTING_KEY,
        checked,
      );
      if (saved !== true) throw new Error("Setting not saved");
      setEnabled(checked);
    } catch {
      message.error(t(I18N_KEYS.Toast.ERROR.CONFIG_SAVE_FAILED));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row
      label={t(I18N_KEYS.Update.AUTO_DOWNLOAD)}
      desc={t(I18N_KEYS.Update.AUTO_DOWNLOAD_DESC)}
      control={
        <Switch
          aria-label={t(I18N_KEYS.Update.AUTO_DOWNLOAD)}
          checked={enabled}
          disabled={!ready || saving}
          loading={saving}
          onChange={(checked) => {
            void change(checked);
          }}
        />
      }
    />
  );
}
