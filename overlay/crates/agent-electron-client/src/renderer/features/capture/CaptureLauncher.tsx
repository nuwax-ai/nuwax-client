import React, { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Modal, Select, Space, message } from "antd";
import { CameraOutlined, CloseOutlined, FileGifOutlined, LoadingOutlined, SaveOutlined, VideoCameraOutlined } from "@ant-design/icons";
import type { CaptureCapabilities, CaptureQuality, CaptureResult, CaptureState, CaptureSuccess, HostCaptureBridge, RecordOutput } from "@shared/features/capture/contract";
import { readCaptureBlob } from "./result";

interface Props {
  capture?: HostCaptureBridge;
  t(key: string): string;
  /** Windows 沿用自绘菜单栏；macOS 保留相机入口并另有系统原生菜单。 */
  menuLabel?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

/** 壳上的直接验收入口；业务页继续使用同一服务的独立受信桥。 */
export const CaptureLauncher: React.FC<Props> = ({ capture, t, menuLabel, open, onOpenChange }) => {
  const [caps, setCaps] = useState<CaptureCapabilities | null>(null);
  const [state, setState] = useState<CaptureState>("idle");
  const [pending, setPending] = useState(false);
  const [quality, setQuality] = useState<CaptureQuality>("high");
  const [preview, setPreview] = useState<{ result: CaptureSuccess; url: string | null } | null>(null);
  const previewRef = useRef<typeof preview>(null);
  const alive = useRef(true);
  const pendingRef = useRef(false);
  const stateRef = useRef<CaptureState>("idle");
  const runRef = useRef<(output?: RecordOutput) => Promise<void>>(async () => undefined);
  const [saving, setSaving] = useState(false);
  const text = (key: string) => t(`Claw.Capture.${key}`);

  useEffect(() => {
    alive.current = true;
    if (!capture) return;
    void capture.getCapabilities().then((value) => {
      if (alive.current) setCaps(value);
    }).catch(() => { if (alive.current) setCaps(null); });
    const off = capture.onStateChange((next) => {
      stateRef.current = next;
      if (alive.current) setState(next);
    });
    return () => {
      alive.current = false;
      off();
      const current = previewRef.current;
      if (current?.url) URL.revokeObjectURL(current.url);
      if (current) void capture.release(current.result.resultId);
      previewRef.current = null;
    };
  }, [capture]);

  const closePreview = () => {
    const current = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    if (current?.url) URL.revokeObjectURL(current.url);
    if (current && capture) void capture.release(current.result.resultId);
  };

  const run = async (output?: RecordOutput) => {
    if (!capture) return;
    if (pendingRef.current || stateRef.current !== "idle" || previewRef.current) {
      message.error(text("error.busy"));
      return;
    }
    pendingRef.current = true;
    setPending(true);
    let result: CaptureResult | undefined;
    try {
      const currentCaps = await capture.getCapabilities();
      if (!alive.current) return;
      setCaps(currentCaps);
      if (!currentCaps.available) { message.error(text("error.unsupported")); return; }
      if (output && (output === "gif" ? !currentCaps.formats.gif : !currentCaps.formats.video.includes(output))) {
        message.error(text("error.encoderUnavailable"));
        return;
      }
      result = output
        ? await capture.record({ output, compression: { quality }, maxDurationMs: 5 * 60 * 1000 })
        : await capture.screenshot({ compression: { quality } });
      if (!result.success) {
        const errorKey = result.code.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        if (alive.current && result.code !== "canceled") message.error(`${text(`error.${errorKey}`)}${result.error ? ` · ${result.error}` : ""}`);
        return;
      }
      if (!alive.current) { await capture.release(result.resultId); return; }
      const blob = await readCaptureBlob(capture, result);
      if (!alive.current) { await capture.release(result.resultId); return; }
      const next = { result, url: blob ? URL.createObjectURL(blob) : null };
      previewRef.current = next;
      setPreview(next);
    } catch (error) {
      if (result?.success) await capture.release(result.resultId);
      if (alive.current) message.error(`${text("error.failed")} · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      pendingRef.current = false;
      if (alive.current) setPending(false);
    }
  };
  runRef.current = run;

  useEffect(() => capture?.onMenuAction?.((action) => {
    void runRef.current(action === "screenshot" ? undefined : action);
  }), [capture]);

  const save = async () => {
    const current = previewRef.current;
    if (!capture || !current || saving) return;
    setSaving(true);
    try {
      const result = await capture.save(current.result.resultId);
      if (result.success) { message.success(text("saved")); closePreview(); }
      else if (!result.canceled) message.error(`${text("saveFailed")} · ${result.error || ""}`);
    } catch (error) {
      message.error(`${text("saveFailed")} · ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (alive.current) setSaving(false); }
  };

  if (!capture || !caps?.available) return null;
  const busy = pending || state !== "idle";
  const menuText = (label: string, shortcut?: string) => menuLabel
    ? <span className="topbar-menu-row"><span>{label}</span>{shortcut && <span className="topbar-menu-shortcut">{shortcut}</span>}</span>
    : label;
  return <>
    <Dropdown trigger={["click"]} open={open} onOpenChange={onOpenChange} menu={{ onClick: () => onOpenChange?.(false), items: [
      { key: "screenshot", icon: <CameraOutlined />, label: menuText(text("screenshot"), "Ctrl+Alt+S"), disabled: busy || !!preview, onClick: () => void run() },
      ...(["mp4", "webm", "gif"] as const).map((output) => ({
        key: output, icon: output === "gif" ? <FileGifOutlined /> : <VideoCameraOutlined />, label: menuText(`${text("record")} · ${output.toUpperCase()}`, output === "mp4" ? "Ctrl+Alt+R" : undefined),
        disabled: busy || !!preview || (output === "gif" ? !caps.formats.gif : !caps.formats.video.includes(output)),
        onClick: () => void run(output),
      })),
      ...(busy ? [{ key: "cancel", icon: <CloseOutlined />, label: text("cancel"), onClick: () => void capture.cancel() }] : []),
    ] }} dropdownRender={(menu) => <div style={{ background: "var(--color-bg-elevated, white)", borderRadius: 8, boxShadow: "0 6px 24px #0002" }}>
      {menu}
      <Space style={{ padding: "8px 12px" }}><span>{text("quality")}</span>
        <Select size="small" value={quality} disabled={busy} style={{ width: 105 }} onChange={setQuality}
          options={["lossless", "high", "medium", "low"].map((value) => ({ value, label: text(`quality.${value}`) }))} />
      </Space>
    </div>}>
      {menuLabel ? <button type="button" className="topbar-menu-btn" aria-label={text("title")}>{text("title")}</button> : <Button type="text" size="small" aria-label={text("title")} title={text("title")}
        style={{ width: 26, height: 26, padding: 0, WebkitAppRegion: "no-drag" } as React.CSSProperties}
        icon={busy ? <LoadingOutlined /> : <CameraOutlined />} />}
    </Dropdown>
    <Modal open={!!preview} title={text("preview")} onCancel={closePreview} width={880}
      footer={<Space><Button onClick={closePreview} disabled={saving}>{text("close")}</Button>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>{text("save")}</Button></Space>}>
      {preview && <>
        {preview.url ? preview.result.mime.startsWith("video/")
          ? <video src={preview.url} controls style={{ maxWidth: "100%", maxHeight: "65vh" }} />
          : <img src={preview.url} alt={text("preview")} style={{ maxWidth: "100%", maxHeight: "65vh", display: "block", margin: "auto" }} />
          : <p>{text("saveToView")}</p>}
        <p style={{ color: "#666", marginTop: 12 }}>{preview.result.width} × {preview.result.height} · {(preview.result.bytes / 1024 / 1024).toFixed(2)} MB
          {preview.result.durationMs !== undefined ? ` · ${(preview.result.durationMs / 1000).toFixed(1)} s` : ""}</p>
        {preview.result.exceedsMaxBytes && <p>{text("exceedsMaxBytes")}</p>}
      </>}
    </Modal>
  </>;
};
