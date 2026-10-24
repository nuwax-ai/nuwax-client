import React, { useState } from "react";
import { Button, Space, Tag, message } from "antd";
import type { ComputerUseAPI, CuaControlResult, CuaRuntime } from "@shared/features/computer-use/contract";
import { CUA_REASON_KEYS, actionKind } from "@shared/features/computer-use/presentation";

export function CuaTaskSummary({ task, t }: { task: CuaRuntime; t: (key: string, ...args: any[]) => string }) {
  const latest = task.steps?.at(-1);
  return <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "6px 0" }}>
    <span>{t("Claw.Cua.steps", { count: task.stepCount ?? 0 })}</span>
    {latest && <span> · {t("Claw.Cua.latestAction")}: {t("Claw.Cua.action." + actionKind(latest.tool))} · {t("Claw.Cua.outcome." + latest.outcome)}</span>}
    {task.reason && <p style={{ margin: "4px 0" }}>{t("Claw.Cua.reason." + (CUA_REASON_KEYS.includes(task.reason) ? task.reason : "generic"))}</p>}
  </div>;
}

export function CuaTaskPanel({ api, runtime, t, accept }: {
  api: ComputerUseAPI; runtime: CuaRuntime; t: (key: string, ...args: any[]) => string;
  accept: (state: CuaRuntime) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, action: () => Promise<CuaControlResult>) => {
    setBusy(id);
    try {
      const result = await action();
      if (result.runtime) accept(result.runtime);
      if (!result.success) message.error(t("Claw.Cua.reason." + (CUA_REASON_KEYS.includes(result.error ?? "") ? result.error : "generic")));
    } catch { message.error(t("Claw.Cua.reason.generic")); }
    finally { setBusy(null); }
  };
  return <section aria-label={t("Claw.Cua.multiwindow.title")} style={{ maxHeight: 380, overflowY: "auto", minWidth: 360 }}>
    <Space wrap>
      <strong>{t("Claw.Cua.title")}</strong>
      <Button danger size="small" onClick={() => void run("*", () => api.stopAll())}>{t("Claw.Cua.stop")}</Button>
      {runtime.recoverable && <Button size="small" disabled={runtime.controlPending || busy === "*"}
        onClick={() => void run("*", () => api.recover())}>{t("Claw.Cua.recover")}</Button>}
    </Space>
    <p style={{ fontSize: 12 }}>{t("Claw.Cua.multiwindow.description")}</p>
    {(runtime.tasks ?? []).map((task, index) => {
      const terminal = ["completed", "stopped", "failed"].includes(task.phase);
      return <article key={task.taskId} style={{ borderLeft: "3px solid " + task.color, padding: "8px 12px", marginTop: 8 }}>
        <Space wrap>
          <strong>{t("Claw.Cua.multiwindow.task", { count: index + 1 })}</strong>
          <Tag>{t("Claw.Cua.phase." + task.phase)}</Tag>
          {task.controlPending && <span>{t("Claw.Cua.stopping")}</span>}
        </Space>
        <CuaTaskSummary task={task} t={t} />
        <Space wrap>
          {!terminal && <Button size="small" disabled={task.controlPending || busy === task.taskId}
            onClick={() => void run(task.taskId, () => api.takeOverTask(task.taskId))}>{t("Claw.Cua.preview.takeover")}</Button>}
          {task.phase === "running" && <Button size="small" onClick={() => void run(task.taskId, () => api.pauseTask(task.taskId))}>{t("Claw.Cua.pause")}</Button>}
          {task.phase === "paused" && <Button size="small" disabled={task.controlPending || busy === task.taskId}
            onClick={() => void run(task.taskId, () => api.resumeTask(task.taskId))}>{t("Claw.Cua.resume")}</Button>}
          {!terminal && <Button size="small" danger onClick={() => void run(task.taskId, () => api.stopTask(task.taskId))}>{t("Claw.Cua.stop")}</Button>}
        </Space>
      </article>;
    })}
    {!runtime.tasks?.length && <p>{t("Claw.Cua.multiwindow.empty")}</p>}
  </section>;
}
