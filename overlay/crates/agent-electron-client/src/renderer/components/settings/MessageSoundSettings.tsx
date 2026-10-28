import React, { useEffect, useState } from "react";
import { Switch, message } from "antd";
import { IM_MESSAGE_SOUND_SETTING } from "@shared/types/imReceiver";
import { I18N_KEYS } from "@shared/constants";

type RowProps = {
  label: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
};

export function MessageSoundSettings({
  t,
  Row,
}: {
  t: (key: string) => string;
  Row: React.ComponentType<RowProps>;
}) {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        if (!window.electronAPI?.settings?.get)
          throw new Error("Settings unavailable");
        const value = await window.electronAPI.settings.get(
          IM_MESSAGE_SOUND_SETTING
        );
        if (!current) return;
        setEnabled(value !== false);
        setReady(true);
      } catch {
        if (current) message.error(t(I18N_KEYS.Toast.ERROR.LOAD_FAILED));
      }
    })();
    return () => {
      current = false;
    };
  }, [t]);

  const change = async (checked: boolean) => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const saved = await window.electronAPI?.settings?.set(
        IM_MESSAGE_SOUND_SETTING,
        checked
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
      label={t(I18N_KEYS.IM.MESSAGE_SOUND)}
      desc={t(I18N_KEYS.IM.MESSAGE_SOUND_DESC)}
      control={
        <Switch
          aria-label={t(I18N_KEYS.IM.MESSAGE_SOUND)}
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
