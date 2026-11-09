import React, { useEffect, useState } from "react";
import { Alert, Switch, message } from "antd";
import { THEME_PREVIEW_SETTING, THEME_PREVIEW_STATE, type ThemePreviewState } from "@shared/features/themes/contract";

export function ThemePreviewSettings({ Row, t, className }: {
  Row: React.ComponentType<{ label: React.ReactNode; desc?: React.ReactNode; control?: React.ReactNode }>;
  t(key: string): string;
  className?: string;
}) {
  const bridge = window.electronAPI?.settings;
  const [state, setState] = useState<ThemePreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const text = (key: string) => t(`Claw.Themes.preview${key}`);
  const read = async () => await bridge?.get(THEME_PREVIEW_STATE) as ThemePreviewState | null;
  useEffect(() => {
    let active = true;
    void read().then(value => { if (active) setState(value); }).catch(() => {
      if (active) message.error(text("Failed"));
    });
    return () => { active = false; };
  }, [bridge]);
  if (!state?.available) return null;
  return <div className={className} data-theme-part="theme-preview">
    <Row label={text("Title")} desc={<>
      {text("Description")}
      {state.sourceForced && <div>{text("SourceForced")}</div>}
      {!state.assetsReady && <Alert type="info" message={text("MissingAssets")} />}
      {state.error && <Alert type="error" message={text("Failed")} />}
    </>} control={<Switch
      aria-label={text("Title")}
      checked={state.enabled || state.sourceForced}
      loading={busy}
      disabled={state.sourceForced || (!state.assetsReady && !state.enabled)}
      onChange={enabled => void (async () => {
        setBusy(true);
        try {
          if (!await bridge?.set(THEME_PREVIEW_SETTING, enabled)) throw new Error("Theme preview change rejected");
          setState(await read());
          message.success(text("Saved"));
        } catch {
          message.error(text("Failed"));
          try { setState(await read()); } catch { /* Preserve the last observed state. */ }
        } finally { setBusy(false); }
      })()}
    />} />
  </div>;
}
