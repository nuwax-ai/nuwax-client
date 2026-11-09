import React, { useEffect, useState } from "react";
import { Button, Space, Switch, message } from "antd";
import type { WorkbenchState } from "@shared/features/workbench/contract";

export function WorkbenchSettings({ Row, t }: {
  Row: React.ComponentType<{ label: React.ReactNode; desc?: React.ReactNode; control?: React.ReactNode }>;
  t(key: string): string;
}) {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await window.electronAPI?.workbench?.control("state");
        if (active && result?.ok && result.state) setState(result.state);
      } catch { /* A subsequent refresh can recover. */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const change = async (action: "access" | "stop", enabled?: boolean) => {
    setBusy(true);
    try {
      const result = await window.electronAPI?.workbench?.control(action, enabled);
      if (!result?.ok) throw new Error(result?.error);
      if (result.state) setState(result.state);
    } catch { message.error(t("Claw.Workbench.failed")); }
    finally { setBusy(false); }
  };
  return <Row label={t("Claw.Workbench.title")} desc={<>
    {t("Claw.Workbench.description")}
    {state && <div>{t("Claw.Dsh.status." + state.phase)}{state.error ? ` · ${state.error}` : ""}</div>}
  </>} control={<Space wrap>
    <Switch checked={state?.agentAccess === true} loading={busy} aria-label={t("Claw.Workbench.agentAccess")}
      checkedChildren={t("Claw.Workbench.agentAccess")} unCheckedChildren={t("Claw.Workbench.agentAccess")}
      onChange={enabled => void change("access", enabled)} />
    <Button disabled={busy || state?.phase !== "ready"} onClick={() => void change("stop")}>{t("Claw.Dsh.stop")}</Button>
  </Space>} />;
}
