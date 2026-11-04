import React, { useEffect, useState } from "react";
import { Alert, Button, Select, Space, Switch } from "antd";
import { shellDomains, type ShellAccess, type ShellCapabilitiesState, type ShellDomain } from "@shared/features/shell-capabilities/contract";
import { getThemesBridge } from "../themes/state";

export function ShellCapabilitiesSettings({ t, Row }: {
  t(key: string): string;
  Row: React.ComponentType<{ label: React.ReactNode; desc?: React.ReactNode; control?: React.ReactNode }>;
}) {
  const bridge = window.electronAPI?.shellCapabilities;
  const [state, setState] = useState<ShellCapabilitiesState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [historyId, setHistoryId] = useState<string>();
  const text = (key: string) => t(`Claw.ShellCapabilities.${key}`);
  useEffect(() => {
    let current = true;
    const refresh = () => { void bridge?.getState().then(value => { if (current) setState(value); }).catch(() => { if (current) setError(text("failed")); }); };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { current = false; clearInterval(timer); };
  }, [bridge]);
  if (!bridge || !state) return null;
  const perform = async (run: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await run(); setState(await bridge.getState()); }
    catch { setError(text("failed")); }
    finally { setBusy(false); }
  };
  const setAccess = (domain: ShellDomain, enabled: boolean) => {
    const access: ShellAccess = { ...state.access, [domain]: enabled };
    void perform(async () => { setState(await bridge.setAccess(access)); });
  };
  return <>
    <Row label={text("title")} desc={<>{text("description")}<div>{state.ready ? text("ready") : text("inactive")}</div>
      {(error || state.error) && <Alert type="error" message={error || text("failed")} />}</>} />
    {shellDomains.map(domain => <Row key={domain} label={text(domain)} desc={text(`${domain}Description`)}
      control={<Switch aria-label={text(domain)} checked={state.access[domain]} loading={busy} onChange={enabled => setAccess(domain, enabled)} />} />)}
    <Row label={text("history")} desc={text("historyDescription")} control={<Space wrap>
      <Select aria-label={text("history")} style={{ minWidth: 180 }} disabled={busy || !state.history.length}
        value={state.history.some(row => row.id === historyId) ? historyId : undefined} placeholder={text("chooseHistory")}
        onChange={setHistoryId} options={state.history.map(row => ({ value: row.id, label: `${row.themeId} · ${new Date(row.at).toLocaleString()}` }))} />
      <Button disabled={busy || !historyId || !state.history.some(row => row.id === historyId)} onClick={() => void perform(async () => {
        const theme = await getThemesBridge()?.getState();
        if (!theme || !historyId) throw new Error("Theme state unavailable");
        await bridge.restoreTheme(historyId, theme.revision); setHistoryId(undefined);
      })}>{text("restore")}</Button>
    </Space>} />
    {state.changes.length > 0 && <Row label={text("changes")} desc={<details><summary>{text("showChanges")}</summary>
      <ul>{state.changes.slice(0, 10).map(change => <li key={change.id}>
        {text(`operations.${change.operation}`)} · {text(`outcomes.${change.status}`)} · {new Date(change.at).toLocaleString()}
      </li>)}</ul>
    </details>} />}
  </>;
}
