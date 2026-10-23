import React, { useEffect, useState } from "react";
import { Button, Empty, Modal, Space, Tabs, Tag, message } from "antd";
import type { ComputerUseAPI, CuaRuntime, CuaTaskHistory } from "@shared/features/computer-use/contract";
import { CuaTaskPanel } from "./CuaTaskPanel";

type Props = { api?: ComputerUseAPI; runtime: CuaRuntime | null; accept: (state: CuaRuntime) => void; t: (key: string, ...args: any[]) => string };
/** Opened by the native tray, rendered inside the client so its lifecycle stays with the owner. */
export function CuaTaskCenter({ api, runtime, accept, t }: Props) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<CuaTaskHistory[]>([]);
  const [tab, setTab] = useState("active");
  useEffect(() => {
    const show = () => { setOpen(true); setTab("active"); };
    window.electronAPI?.on("cua:openCenter", show);
    return () => window.electronAPI?.off("cua:openCenter", show);
  }, []);
  useEffect(() => {
    if (!open || !api?.getTaskHistory) return;
    let current = true;
    void api.getTaskHistory().then(rows => { if (current) setHistory(rows); }).catch(() => undefined);
    return () => { current = false; };
  }, [open, api, runtime?.revision]);
  if (!api || !open) return null;
  const control = async (action: () => ReturnType<ComputerUseAPI["stop"]>) => {
    try { const result = await action(); if (result.runtime) accept(result.runtime);
      if (!result.success) message.error(t("Claw.Cua.reason.generic")); }
    catch { message.error(t("Claw.Cua.reason.generic")); }
  };
  const active = (runtime?.tasks ?? []).filter(task => ["running", "paused"].includes(task.phase));
  const activeCount = runtime?.multiwindow ? active.length : runtime && ["running", "paused"].includes(runtime.phase) ? 1 : 0;
  return <Modal open title={t("Claw.Cua.center.open")} footer={null} width={640} onCancel={() => setOpen(false)}>
    <Tabs activeKey={tab} onChange={setTab} items={[
      { key: "active", label: `${t("Claw.Cua.center.active")} (${activeCount})`, children:
        runtime?.multiwindow && active.length ? <CuaTaskPanel api={api} runtime={{ ...runtime, tasks: active }} accept={accept} t={t} />
          : runtime && ["running", "paused"].includes(runtime.phase) ? <Space wrap>
            <span>{runtime.scope?.kind === "window" ? runtime.scope.label : t("Claw.Cua.scope.desktop")}</span>
            <Button onClick={() => void api.showTaskPreview(runtime.taskId!)}>{t("Claw.Cua.preview.expand")}</Button>
            <Button onClick={() => void control(() => api.takeOver())}>{t("Claw.Cua.preview.takeover")}</Button>
            <Button danger onClick={() => void control(() => api.stop())}>{t("Claw.Cua.stop")}</Button>
          </Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Claw.Cua.center.emptyActive")} /> },
      { key: "history", label: `${t("Claw.Cua.center.history")} (${history.length})`, children: <>
        <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>{t("Claw.Cua.center.historyDescription")}</p>
        {!!history.length && <Button size="small" onClick={() => void api.clearTaskHistory().then(result => {
          if (result.success) setHistory([]); else message.error(t("Claw.Cua.reason.generic"));
        }).catch(() => message.error(t("Claw.Cua.reason.generic")))}>{t("Claw.Cua.clear")}</Button>}
        <div style={{ maxHeight: 400, overflowY: "auto" }}>{history.map(row => <article key={row.taskId} style={{ padding: "12px 0", borderBottom: "1px solid #8882" }}>
          <Space wrap><strong>{row.label || t("Claw.Cua.scope.desktop")}</strong><Tag>{t("Claw.Cua.phase." + row.phase)}</Tag></Space>
          <div style={{ fontSize: 12, opacity: .65, marginTop: 4 }}>{new Date(row.endedAt).toLocaleString()} · {t("Claw.Cua.steps", { count: row.stepCount })}</div>
        </article>)}</div>
        {!history.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Claw.Cua.center.emptyHistory")} />}
      </> },
    ]} />
  </Modal>;
}
