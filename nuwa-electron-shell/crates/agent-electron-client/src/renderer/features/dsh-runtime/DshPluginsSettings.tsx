import React, { useState } from "react";
import { Alert, Button, Input, Modal, Space, Switch, Tag } from "antd";
import type { DshPluginBundle, DshPluginConfiguration, DshPluginOperation } from "@shared/features/dsh-runtime/contract";

export function DshPluginsSettings({ t, enabled }: { t(key: string): string; enabled: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [bundles, setBundles] = useState<DshPluginBundle[]>([]), [configuration, setConfiguration] = useState<DshPluginConfiguration[]>([]);
  const [target, setTarget] = useState(""), [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<DshPluginConfiguration | null>(null), [patch, setPatch] = useState("");
  const text = (key: string) => t(`Claw.Dsh.plugins.${key}`);
  const call = async (operation: DshPluginOperation, input?: { target?: string; patch?: Record<string, unknown>; expectedRevision?: number }) => {
    const reply = await window.electronAPI?.dshRuntime.plugins(operation, input);
    if (!reply?.ok) throw new Error(reply?.error || t("Claw.Dsh.failed"));
    return reply.value;
  };
  const refresh = async () => {
    const value = await call("list");
    setBundles(value?.bundles ?? []); setConfiguration(value?.configuration ?? []);
  };
  const perform = async (run: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await run(); } catch (failure) { setError(failure instanceof Error ? failure.message : t("Claw.Dsh.failed")); }
    finally { setBusy(false); }
  };
  const change = async (operation: DshPluginOperation, name: string) => {
    const value = await call(operation, { target: name });
    setNotice(value?.application === "restart-required" || value?.restartReason ? text("restart") : text("saved"));
    await refresh();
  };
  const confirm = (operation: "install" | "remove", name: string) => Modal.confirm({
    title: operation === "install" ? text("install") : text("remove"),
    content: operation === "install" ? text("trust") : name,
    okText: text("confirm"), cancelText: t("Claw.Dsh.cancel"),
    onOk: () => perform(async () => { await change(operation, name); setTarget(""); }),
  });
  return <>
    <Button disabled={!enabled || busy} onClick={() => { setOpen(true); void perform(refresh); }}>{text("title")}</Button>
    <Modal title={text("title")} open={open} width={720} footer={null} onCancel={() => setOpen(false)} destroyOnClose>
      <p>{text("description")}</p>
      {error && <Alert type="error" message={error} showIcon />}
      {notice && <Alert type="info" message={notice} showIcon />}
      <Space.Compact style={{ width: "100%", margin: "12px 0" }}>
        <Input aria-label={text("package")} placeholder={text("package")} value={target} disabled={busy} onChange={event => setTarget(event.target.value)} />
        <Button disabled={busy || !target.trim()} onClick={() => confirm("install", target.trim())}>{text("install")}</Button>
        <Button disabled={busy} onClick={() => void perform(refresh)}>{text("refresh")}</Button>
      </Space.Compact>
      {bundles.map(bundle => <div key={bundle.name} style={{ padding: "12px 0", borderBottom: "1px solid var(--nuwax-border-default, #8883)" }}>
        <Space wrap><strong>{bundle.name}</strong><span>{bundle.version}</span>{bundle.protected && <Tag>{text("core")}</Tag>}{!bundle.installed && <Tag>{text("notInstalled")}</Tag>}</Space>
        <Space wrap style={{ float: "right" }}>
          <Switch checked={bundle.enabled} disabled={busy || !bundle.installed || bundle.protected || !!bundle.readOnlyReason} aria-label={`${bundle.name} ${text("enabled")}`} onChange={value => void perform(() => change(value ? "enable" : "disable", bundle.name))} />
          {!bundle.installed && !bundle.protected && <Button size="small" disabled={busy} onClick={() => confirm("install", bundle.name)}>{text("install")}</Button>}
          {!bundle.protected && bundle.removable && <Button size="small" danger disabled={busy} onClick={() => confirm("remove", bundle.name)}>{text("remove")}</Button>}
        </Space>
      </div>)}
      {configuration.length > 0 && <details style={{ marginTop: 12 }}><summary>{text("publicConfiguration")}</summary>
        {configuration.map(item => <div key={item.ns}><code>{item.ns}</code> <Button size="small" disabled={busy} onClick={() => { setEditing(item); setPatch("{}"); }}>{text("configure")}</Button></div>)}
      </details>}
    </Modal>
    <Modal title={`${text("configure")} · ${editing?.ns ?? ""}`} open={!!editing} confirmLoading={busy} okText={text("saved")} cancelText={t("Claw.Dsh.cancel")} onCancel={() => { if (!busy) setEditing(null); }} onOk={() => void perform(async () => {
      if (!editing) return;
      const value: unknown = JSON.parse(patch);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(text("invalidJson"));
      await call("configure", { target: editing.ns, patch: value as Record<string, unknown>, expectedRevision: editing.revision });
      await refresh(); setEditing(null); setNotice(text("saved"));
    })}>
      <p>{text("patchHint")}</p>
      {error && <Alert type="error" message={error} showIcon />}
      <pre style={{ maxHeight: 160, overflow: "auto" }}>{JSON.stringify(editing?.value, null, 2)}</pre>
      <Input.TextArea aria-label={text("patchHint")} rows={6} value={patch} disabled={busy} onChange={event => setPatch(event.target.value)} />
    </Modal>
  </>;
}
