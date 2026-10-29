import React, { useEffect, useState } from "react";
import { Select, message } from "antd";
import {
  BROWSER_SETTING,
  linkOpenMode,
  type BrowserBridge,
  type LinkOpenMode,
} from "@shared/features/browser/contract";
type Settings = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<boolean>;
};
export function BrowserSettings({
  bridge,
  settings,
  Row,
  t,
}: {
  bridge?: BrowserBridge;
  settings?: Settings;
  Row: React.ComponentType<{
    label: React.ReactNode;
    desc?: React.ReactNode;
    control?: React.ReactNode;
  }>;
  t(key: string): string;
}) {
  const [mode, setMode] = useState<LinkOpenMode>("in-app");
  const [available, setAvailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    void Promise.all([
      bridge?.getCapabilities().catch(() => ({ available: false })),
      settings?.get(BROWSER_SETTING),
    ])
      .then(([caps, value]) => {
        if (current) {
          setAvailable(caps?.available === true);
          setMode(linkOpenMode(value));
          setReady(true);
        }
      })
      .catch(() => {
        if (current) message.error(t("Claw.Browser.settingsLoadFailed"));
      });
    return () => {
      current = false;
    };
  }, [bridge, settings, t]);
  const change = async (value: LinkOpenMode) => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      if ((await settings?.set(BROWSER_SETTING, value)) !== true)
        throw new Error("Preference not saved");
      setMode(value);
    } catch {
      message.error(t("Claw.Browser.settingsSaveFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Row
      label={t("Claw.Browser.settingsTitle")}
      desc={t(
        available ? "Claw.Browser.settingsDesc" : "Claw.Browser.unavailableDesc"
      )}
      control={
        <Select
          aria-label={t("Claw.Browser.settingsTitle")}
          value={available ? mode : "system"}
          disabled={!ready || saving || !settings}
          loading={saving}
          style={{ minWidth: 190 }}
          options={[
            ...(available
              ? [{ value: "in-app", label: t("Claw.Browser.inApp") }]
              : []),
            { value: "system", label: t("Claw.Browser.system") },
          ]}
          onChange={(value) => {
            void change(value);
          }}
        />
      }
    />
  );
}
