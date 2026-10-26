import React, { useEffect, useState } from "react";
import { Switch, message } from "antd";
import {
  LOCAL_FILES_ENABLED_BY_DEFAULT,
  LOCAL_FILES_ENABLED_SETTING,
} from "@shared/features/local-files/contract";

type RowProps = {
  label: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
};

/** 配置入口始终可见，特性关闭后仍可重新开启；注册状态在重启时切换。 */
export function LocalFilesSettings({ t, Row }: {
  t: (key: string) => string;
  Row: React.ComponentType<RowProps>;
}) {
  const [enabled, setEnabled] = useState<boolean>(LOCAL_FILES_ENABLED_BY_DEFAULT);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        if (!window.electronAPI?.settings?.get) throw new Error("Settings unavailable");
        const value = await window.electronAPI.settings.get(LOCAL_FILES_ENABLED_SETTING);
        if (!current) return;
        setEnabled(typeof value === "boolean" ? value : LOCAL_FILES_ENABLED_BY_DEFAULT);
        setReady(true);
      } catch {
        if (current) message.error(t("Claw.Toast.Error.loadFailed"));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [t]);

  const change = async (checked: boolean) => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const saved = await window.electronAPI?.settings?.set(LOCAL_FILES_ENABLED_SETTING, checked);
      if (saved !== true) throw new Error("Setting not saved");
      setEnabled(checked);
      message.success(t("Claw.Settings.localFiles.savedRestart"));
    } catch {
      message.error(t("Claw.Toast.Error.configSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return <Row
    label={t("Claw.Settings.localFiles.label")}
    desc={t("Claw.Settings.localFiles.desc")}
    control={<Switch
      aria-label={t("Claw.Settings.localFiles.label")}
      checked={enabled}
      disabled={!ready || saving}
      loading={loading || saving}
      onChange={(checked) => { void change(checked); }}
    />}
  />;
}
