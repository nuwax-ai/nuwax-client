import React, { useEffect, useState } from "react";
import { Button, Checkbox, Modal, Space, Switch, message } from "antd";
import { DshPluginsSettings } from "./DshPluginsSettings";
import { WorkbenchSettings } from "../workbench/WorkbenchSettings";
import type { DshAction, DshModel, DshReply, DshStatus } from "@shared/features/dsh-runtime/contract";

export function DshSettings({ Row, t }: {
  Row: React.ComponentType<{ label: React.ReactNode; desc?: React.ReactNode; control?: React.ReactNode }>;
  t(key: string): string;
}) {
  const [models, setModels] = useState<DshModel[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<DshStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => { void window.electronAPI?.dshRuntime?.control("status").then(reply => {
      if (active && reply.ok && reply.status) setStatus(reply.status);
    }).catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const call = async (action: DshAction, ids?: string[]): Promise<DshReply> => {
    const result = await window.electronAPI?.dshRuntime?.control(action, ids);
    if (!result?.ok) throw new Error(result?.error || t("Claw.Dsh.unavailable"));
    if (result.status) setStatus(result.status);
    return result;
  };
  const perform = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try { await run(); } catch (error) { message.error(t("Claw.Dsh.failed") + ": " + (error instanceof Error ? error.message : "")); }
    finally { setBusy(false); }
  };
  const enabled = status?.enabled ?? status?.phase === "ready";
  const modelsDialog = async () => { const value = await call("catalog"); setModels(value.models ?? []); setSelected([]); };
  return <>
    <WorkbenchSettings Row={Row} t={t} />
    <Row label={t("Claw.Dsh.title")} desc={<>{t("Claw.Dsh.description")}{status && <div>{t("Claw.Dsh.status." + status.phase)}{status.error ? ": " + status.error : ""}</div>}</>} control={
      <Space wrap>
        <Switch aria-label={t("Claw.Dsh.enabled")} checked={enabled} loading={busy} onChange={on => void perform(async () => {
          if (!on) { await call("stop"); return; }
          try { await call("open"); } catch (failure) {
            if (!(failure instanceof Error) || !failure.message.includes("Authorize Nuwax models")) throw failure;
            await modelsDialog();
          }
        })} />
        <Button disabled={busy} onClick={() => void perform(modelsDialog)}>{t("Claw.Dsh.models")}</Button>
        <Button disabled={busy || !enabled} onClick={() => void perform(() => call("open"))}>{t("Claw.Dsh.open")}</Button>
        <DshPluginsSettings t={t} enabled={enabled && status?.phase === "ready"} />
      </Space>
    } />
    <Modal title={t("Claw.Dsh.models")} open={models !== null} onCancel={() => setModels(null)}
      okText={t("Claw.Dsh.authorize")} cancelText={t("Claw.Dsh.cancel")} confirmLoading={busy}
      okButtonProps={{ disabled: !selected.length || busy }}
      onOk={() => void perform(async () => { await call("authorize", selected); setModels(null); await call("open"); })}>
      <p>{t("Claw.Dsh.authorizationDescription")}</p>
      {models?.length ? <Checkbox.Group value={selected} onChange={values => setSelected(values.map(String))}>
        <Space direction="vertical">{models.map(model => <Checkbox key={model.id} value={model.id} disabled={!!model.reason}>{model.name} · {model.model}{model.reason ? " — " + t("Claw.Dsh.reason." + model.reason) : ""}</Checkbox>)}</Space>
      </Checkbox.Group> : <p>{t("Claw.Dsh.noModels")}</p>}
    </Modal>
  </>;
}
