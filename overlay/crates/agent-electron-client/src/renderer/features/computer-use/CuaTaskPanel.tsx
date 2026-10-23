import React, { useState } from "react";
import { Button, Select, Space, Tag, message } from "antd";
import type { ComputerUseAPI, CuaControlResult, CuaRuntime, CuaWindow } from "@shared/features/computer-use/contract";
import { CUA_REASON_KEYS, actionKind, canPreviewCuaTask } from "@shared/features/computer-use/presentation";

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
  const [windows, setWindows] = useState<CuaWindow[]>([]);
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
      <strong>{t("Claw.Cua.multiwindow.title")}</strong>
      <Button size="small" onClick={() => { void api.listWindows().then((result) => setWindows(result.windows ?? []))
        .catch(() => message.error(t("Claw.Cua.reason.generic"))); }}>{t("Claw.Cua.scope.refresh")}</Button>
      <Button danger size="small" onClick={() => void run("*", () => api.stopAll())}>{t("Claw.Cua.multiwindow.stopAll")}</Button>
      {runtime.recoverable && <Button size="small" disabled={runtime.controlPending || busy === "*"}
        onClick={() => void run("*", () => api.recover())}>{t("Claw.Cua.recover")}</Button>}
    </Space>
    <p style={{ fontSize: 12 }}>{t("Claw.Cua.multiwindow.description")}</p>
    {(runtime.tasks ?? []).map((task, index) => {
      const terminal = ["completed", "stopped", "failed"].includes(task.phase);
      const scope = task.scope?.kind === "window" ? task.scope : undefined;
      const selected = scope && scope.windowId > 0 ? scope.pid + ":" + scope.windowId : undefined;
      const options = windows.map((window) => ({ value: window.pid + ":" + window.windowId, label: window.label }));
      if (selected && !options.some((option) => option.value === selected)) options.push({ value: selected, label: scope!.label });
      return <article key={task.taskId} style={{ borderLeft: "3px solid " + task.color, padding: "8px 12px", marginTop: 8 }}>
        <Space wrap>
          <strong>{t("Claw.Cua.multiwindow.task", { count: index + 1 })}</strong>
          <Tag>{t("Claw.Cua.phase." + task.phase)}</Tag>
          <Tag>{t("Claw.Cua.multiwindow." + task.mode)}</Tag>
          {task.queued && <span>{t("Claw.Cua.reason.taskQueued")}</span>}
          {task.controlPending && <span>{t("Claw.Cua.stopping")}</span>}
        </Space>
        <CuaTaskSummary task={task} t={t} />
        <div style={{ margin: "8px 0" }}>
          <Select aria-label={t("Claw.Cua.scope.choose")} style={{ width: 320, maxWidth: "100%" }}
            value={selected} placeholder={t("Claw.Cua.scope.choose")} options={options}
            disabled={terminal || task.controlPending || busy === task.taskId || task.phase === "running"}
            onDropdownVisibleChange={(open) => { if (open) void api.listWindows().then((result) => setWindows(result.windows ?? [])).catch(() => undefined); }}
            onChange={(value) => {
              const target = windows.find((window) => window.pid + ":" + window.windowId === value);
              if (target) void run(task.taskId, () => api.bindTarget(task.taskId, target));
            }} />
        </div>
        <Space wrap>
          <Button size="small" disabled={!canPreviewCuaTask(task)} onClick={() => void api.showTaskPreview(task.taskId)}>{t("Claw.Cua.preview.expand")}</Button>
          {!terminal && <Button size="small" disabled={!selected || task.controlPending || busy === task.taskId}
            onClick={() => void run(task.taskId, () => api.takeOverTask(task.taskId))}>{t("Claw.Cua.preview.takeover")}</Button>}
          {task.phase === "running" && <Button size="small" onClick={() => void run(task.taskId, () => api.pauseTask(task.taskId))}>{t("Claw.Cua.pause")}</Button>}
          {task.phase === "paused" && <Button size="small" disabled={!selected || task.controlPending || busy === task.taskId}
            onClick={() => void run(task.taskId, () => api.resumeTask(task.taskId))}>{t("Claw.Cua.resume")}</Button>}
          {!terminal && <Button size="small" danger onClick={() => void run(task.taskId, () => api.stopTask(task.taskId))}>{t("Claw.Cua.stop")}</Button>}
          {!terminal && <Button size="small" disabled={!selected || task.controlPending || busy === task.taskId}
            onClick={() => void run(task.taskId, () => api.setTaskMode(task.taskId, task.mode === "background" ? "foreground" : "background"))}>
            {t(task.mode === "background" ? "Claw.Cua.multiwindow.useForeground" : "Claw.Cua.multiwindow.useBackground")}
          </Button>}
        </Space>
      </article>;
    })}
    {!runtime.tasks?.length && <p>{t("Claw.Cua.multiwindow.empty")}</p>}
  </section>;
}
