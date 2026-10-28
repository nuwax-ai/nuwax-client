import React, { useEffect, useState } from "react";
import { Button, Empty, Modal, Space, Tag, message } from "antd";
import type { ComputerUseAPI, CuaRuntime } from "@shared/features/computer-use/contract";
import { cuaReasonKey } from "@shared/features/computer-use/presentation";
import { CuaTaskPanel, CuaTaskSummary } from "./CuaTaskPanel";

type Props = { api?: ComputerUseAPI; runtime: CuaRuntime | null; accept: (state: CuaRuntime) => void; t: (key: string, ...args: any[]) => string };
/** Opened by the native tray, rendered inside the client so its lifecycle stays with the owner. */
export function CuaTaskCenter({ api, runtime, accept, t }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.electronAPI?.on("cua:openCenter", show);
    return () => window.electronAPI?.off("cua:openCenter", show);
  }, []);
  if (!api || !open) return null;
  const control = async (action: () => ReturnType<ComputerUseAPI["stop"]>) => {
    try { const result = await action(); if (result.runtime) accept(result.runtime);
      if (!result.success) message.error(t("Claw.Cua.reason." + cuaReasonKey(result.error))); }
    catch { message.error(t("Claw.Cua.reason.generic")); }
  };
  const active = (runtime?.tasks ?? []).filter(task => ["running", "paused"].includes(task.phase));
  const activeCount = runtime?.multiwindow ? active.length : runtime && ["running", "paused"].includes(runtime.phase) ? 1 : 0;
  return <Modal open title={t("Claw.Cua.center.open")} footer={null} width={640} onCancel={() => setOpen(false)}>
    <p style={{ fontSize: 12, opacity: .7 }}>{t("Claw.Cua.center.active")} ({activeCount})</p>
    {runtime?.multiwindow && active.length ? <CuaTaskPanel api={api} runtime={{ ...runtime, tasks: active }} accept={accept} t={t} />
      : runtime && ["running", "paused"].includes(runtime.phase) ? <Space wrap>
        <Tag>{t("Claw.Cua.phase." + runtime.phase)}</Tag>
        <CuaTaskSummary task={runtime} t={t} />
        <Button onClick={() => void control(() => api.takeOver())}>{t("Claw.Cua.preview.takeover")}</Button>
        {runtime.phase === "running" && <Button onClick={() => void control(() => api.pause())}>{t("Claw.Cua.pause")}</Button>}
        <Button danger onClick={() => void control(() => api.stop())}>{t("Claw.Cua.stop")}</Button>
      </Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Claw.Cua.center.emptyActive")} />}
  </Modal>;
}
