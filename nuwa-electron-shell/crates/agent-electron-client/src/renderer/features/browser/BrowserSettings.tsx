import React, { useEffect, useState } from "react";
import { Select, Switch, message } from "antd";
import {
  BROWSER_AGENT_ENABLED_SETTING,
  BROWSER_SETTING,
  isBrowserAgentEnabled,
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
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.all([
      bridge?.getCapabilities().catch(() => ({ available: false })),
      settings?.get(BROWSER_SETTING),
      settings?.get(BROWSER_AGENT_ENABLED_SETTING),
    ])
      .then(([caps, value, agentPreference]) => {
        if (current) {
          setAvailable(caps?.available === true);
          setMode(linkOpenMode(value));
          setAgentEnabled(isBrowserAgentEnabled(agentPreference));
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
  const change = async <T,>(key: string, value: T, setValue: (value: T) => void) => {
    if (!ready || saving) return;
    setSaving(key);
    try {
      if ((await settings?.set(key, value)) !== true)
        throw new Error("Preference not saved");
      setValue(value);
    } catch {
      message.error(t("Claw.Browser.settingsSaveFailed"));
    } finally {
      setSaving(null);
    }
  };
  return (
    <>
      <Row
        label={t("Claw.Browser.settingsTitle")}
        desc={t(
          available ? "Claw.Browser.settingsDesc" : "Claw.Browser.unavailableDesc"
        )}
        control={
          <Select
            aria-label={t("Claw.Browser.settingsTitle")}
            value={available ? mode : "system"}
            disabled={!ready || saving !== null || !settings}
            loading={saving === BROWSER_SETTING}
            style={{ minWidth: 190 }}
            options={[
              ...(available
                ? [{ value: "in-app", label: t("Claw.Browser.inApp") }]
                : []),
              { value: "system", label: t("Claw.Browser.system") },
            ]}
            onChange={(value) => {
              void change(BROWSER_SETTING, value, setMode);
            }}
          />
        }
      />
      {available && (
        <Row
          label={t("Claw.Browser.agentSettingsTitle")}
          desc={t("Claw.Browser.agentSettingsDesc")}
          control={
            <Switch
              aria-label={t("Claw.Browser.agentSettingsTitle")}
              checked={agentEnabled}
              disabled={!ready || saving !== null || !settings}
              loading={saving === BROWSER_AGENT_ENABLED_SETTING}
              onChange={(checked) => {
                void change(BROWSER_AGENT_ENABLED_SETTING, checked, setAgentEnabled);
              }}
            />
          }
        />
      )}
    </>
  );
}
