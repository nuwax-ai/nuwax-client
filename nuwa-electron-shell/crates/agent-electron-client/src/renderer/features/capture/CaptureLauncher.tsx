import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, InputNumber, Modal, Select, Space, message } from "antd";
import { CameraOutlined, CopyOutlined, DownloadOutlined, FileGifOutlined, VideoCameraOutlined } from "@ant-design/icons";
import type { CaptureCapabilities, CaptureMenuAction, CaptureQuality, CaptureResult, CaptureState, CaptureSuccess, HostCaptureBridge, RecordOutput } from "@shared/features/capture/contract";
import { readCaptureBlob } from "./result";
import { CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING, captureShortcut, recordShortcut } from '@shared/features/capture/preferences';
import { CapturePreferences } from './CapturePreferences';
import { RecordingPreview } from './RecordingPreview';
import { DEFAULT_RECORDING_DURATION_MINUTES, MAX_RECORDING_DURATION_MINUTES, RECORDING_DURATION_SETTING, recordingDurationMinutes } from "@shared/features/capture/recordingPreferences";

interface Props {
  capture?: HostCaptureBridge;
  t(key: string): string;
  /** 常驻控制器；仅把操作面板挂到设置页签，不随页签切换卸载。 */
  panelTarget?: Element | null;
  onAvailabilityChange?(available: boolean): void;
  /** 壳自绘菜单使用同一个常驻控制器；卸载时清空动作，避免引用失效入口。 */
  onActionReady?(handler: ((action: CaptureMenuAction) => void) | null): void;
  onShortcutChange?(shortcut: string): void;
  onRecordShortcutChange?(shortcut: string): void;
  /** 等待设置弹窗实际关闭，避免把其关闭动画采进冻结帧。 */
  onCaptureStart?(): Promise<void>;
  settings?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
}

/** 壳上的直接验收入口；业务页继续使用同一服务的独立受信桥。 */
export const CaptureLauncher: React.FC<Props> = ({ capture, t, panelTarget, onAvailabilityChange, onActionReady, onShortcutChange, onRecordShortcutChange, onCaptureStart, settings }) => {
  const [caps, setCaps] = useState<CaptureCapabilities | null>(null);
  const [state, setState] = useState<CaptureState>("idle");
  const [pending, setPending] = useState(false);
  const [quality, setQuality] = useState<CaptureQuality>("high");
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(DEFAULT_RECORDING_DURATION_MINUTES);
  const durationRef = useRef(DEFAULT_RECORDING_DURATION_MINUTES);
  const savedDurationRef = useRef(DEFAULT_RECORDING_DURATION_MINUTES);
  const durationSaveVersion = useRef(0);
  const settingsReady = useRef<Promise<unknown>>(Promise.resolve());
  const [savingDuration, setSavingDuration] = useState(false);
  const [durationReady, setDurationReady] = useState(!settings);
  const [preview, setPreview] = useState<{ result: CaptureSuccess; url: string | null } | null>(null);
  const previewRef = useRef<typeof preview>(null);
  const alive = useRef(true);
  const pendingRef = useRef(false);
  const stateRef = useRef<CaptureState>("idle");
  const runRef = useRef<(output?: RecordOutput) => Promise<void>>(async () => undefined);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const previewAction = useRef(false);
  const text = (key: string) => t(`Claw.Capture.${key}`);

  useEffect(() => {
    let mounted = true;
    settingsReady.current = settings?.get(RECORDING_DURATION_SETTING).then(value => {
      if (!mounted) return;
      durationRef.current = recordingDurationMinutes(value);
      savedDurationRef.current = durationRef.current;
      setMaxDurationMinutes(durationRef.current);
    }).catch(() => undefined).finally(() => { if (mounted) setDurationReady(true); }) ?? Promise.resolve();
    return () => { mounted = false; };
  }, [settings]);

  useEffect(() => {
    let mounted = true;
    void settings?.get(CAPTURE_SHORTCUT_SETTING).then(value => {
      if (mounted) onShortcutChange?.(captureShortcut(value));
    }).catch(() => undefined);
    void settings?.get(CAPTURE_RECORD_SHORTCUT_SETTING).then(value => {
      if (mounted) onRecordShortcutChange?.(recordShortcut(value));
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, [settings, onShortcutChange, onRecordShortcutChange]);

  const changeDuration = (value: number | null) => {
    if (value === null || recordingDurationMinutes(value) !== value) return;
    durationRef.current = value;
    setMaxDurationMinutes(value);
    setSavingDuration(true);
    const previous = settingsReady.current;
    const version = ++durationSaveVersion.current;
    const save = async () => {
      // 顺序持久化；保存期间保持输入可用，避免多位数输入被禁用/失焦打断。
      await previous;
      try {
        const result = await settings?.set(RECORDING_DURATION_SETTING, value);
        if (result === false || (result && typeof result === 'object' && 'success' in result && result.success === false)) throw new Error('preference write failed');
        savedDurationRef.current = value;
      } catch {
        if (alive.current && version === durationSaveVersion.current) {
          durationRef.current = savedDurationRef.current;
          setMaxDurationMinutes(savedDurationRef.current);
          message.error(text('durationSaveFailed'));
        }
      } finally { if (alive.current && version === durationSaveVersion.current) setSavingDuration(false); }
    };
    settingsReady.current = save();
  };

  useEffect(() => {
    alive.current = true;
    if (!capture) return;
    void capture.getCapabilities({ includeRecording: false }).then((value) => {
      if (alive.current) { setCaps(current => current ? { ...value, formats: current.formats } : value); onAvailabilityChange?.(value.available); }
    }).catch(() => { if (alive.current) { setCaps(null); onAvailabilityChange?.(false); } });
    void capture.getCapabilities().then(value => {
      if (alive.current) setCaps(value);
    }).catch(() => undefined);
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
  }, [capture, onAvailabilityChange]);

  const closePreview = () => {
    if (previewAction.current) return;
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
      const currentCaps = await capture.getCapabilities(output ? undefined : { includeRecording: false });
      if (!alive.current) return;
      setCaps(current => !output && current ? { ...currentCaps, formats: current.formats } : currentCaps);
      if (!currentCaps.available) { message.error(text("error.unsupported")); return; }
      if (output && (output === "gif" ? !currentCaps.formats.gif : !currentCaps.formats.video.includes(output))) {
        message.error(text("error.encoderUnavailable"));
        return;
      }
      await onCaptureStart?.();
      let ready: Promise<unknown>;
      do { ready = settingsReady.current; await ready; } while (ready !== settingsReady.current);
      if (!alive.current) return;
      const action = output ?? 'screenshot';
      result = capture.interactive && action !== 'webm'
        ? await capture.interactive({ action, compression: { quality }, maxDurationMs: durationRef.current * 60_000 })
        : output
        ? await capture.record({ output, compression: { quality }, maxDurationMs: durationRef.current * 60_000 })
        : await capture.screenshot({ compression: { quality } });
      if (!result.success) {
        const errorKey = result.code.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        // The host opens the permission guide for permission-denied; a toast would repeat it.
        if (alive.current && result.code !== "canceled" && result.code !== "permission-denied") message.error(`${text(`error.${errorKey}`)}${result.error ? ` · ${result.error}` : ""}`);
        return;
      }
      if (!alive.current) { await capture.release(result.resultId); return; }
      if (result.mime.startsWith('image/') && result.mime !== 'image/gif') {
        const resultId = result.resultId;
        // A confirmed still is the final image. Keep the capture lock until copy finishes.
        result = undefined;
        try {
          const copied = await capture.copy?.(resultId);
          if (alive.current) {
            if (copied?.success) message.success(text('imageCopied'));
            else message.error(text('copyFailed'));
          }
        } catch {
          if (alive.current) message.error(text('copyFailed'));
        } finally { await capture.release(resultId); }
        return;
      }
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

  useEffect(() => {
    const dispatch = (action: CaptureMenuAction) => {
      void runRef.current(action === "screenshot" ? undefined : action);
    };
    onActionReady?.(dispatch);
    const offMenu = capture?.onMenuAction?.(dispatch);
    return () => { offMenu?.(); onActionReady?.(null); };
  }, [capture, onActionReady]);

  const save = async () => {
    const current = previewRef.current;
    if (!capture || !current || previewAction.current) return;
    previewAction.current = true;
    setSaving(true);
    try {
      const result = await capture.save(current.result.resultId);
      if (!alive.current || previewRef.current !== current) return;
      if (result.success) { message.success(text("saved")); previewAction.current = false; closePreview(); }
      else if (!result.canceled) message.error(`${text("saveFailed")} · ${result.error || ""}`);
    } catch (error) {
      if (alive.current && previewRef.current === current) message.error(`${text("saveFailed")} · ${error instanceof Error ? error.message : String(error)}`);
    } finally { previewAction.current = false; if (alive.current) setSaving(false); }
  };

  const copy = async () => {
    const current = previewRef.current;
    if (!capture?.copy || !current || previewAction.current) return;
    previewAction.current = true;
    setCopying(true);
    try {
      const result = await capture.copy(current.result.resultId);
      if (!alive.current || previewRef.current !== current) return;
      if (result.success) message.success(text(result.kind === 'image' ? 'imageCopied' : 'fileCopied'));
      else message.error(text('copyFailed'));
    } catch {
      if (alive.current && previewRef.current === current) message.error(text('copyFailed'));
    } finally { previewAction.current = false; if (alive.current) setCopying(false); }
  };

  if (!capture || !caps?.available) return null;
  const busy = pending || state !== "idle";
  const panel = <div style={{ padding: 20, border: "1px solid var(--color-border)", borderRadius: 12, background: "var(--color-bg-section)" }}>
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <CapturePreferences settings={settings} t={t} disabled={busy} onShortcutChange={onShortcutChange} onRecordShortcutChange={onRecordShortcutChange} />
      <Space><span>{text("quality")}</span>
        <Select value={quality} disabled={busy} style={{ width: 120 }} onChange={setQuality}
          options={["lossless", "high", "medium", "low"].map((value) => ({ value, label: text(`quality.${value}`) }))} />
      </Space>
      <Space direction="vertical" size={6}>
        <Space><span>{text('maxDuration')}</span>
          <InputNumber aria-label={text('maxDuration')} min={1} max={MAX_RECORDING_DURATION_MINUTES} step={1} precision={0}
            value={maxDurationMinutes} disabled={busy || !durationReady} onChange={changeDuration} style={{ width: 100 }} />
          <span>{text('minutes')}</span>
        </Space>
        <span style={{ color: 'var(--color-text-secondary)' }}>{text('maxDurationHint')}</span>
      </Space>
      <Space wrap size={12}>
        <Button icon={<CameraOutlined />} disabled={busy || savingDuration || !!preview} onClick={() => void run()}>{text("screenshot")}</Button>
        {(["mp4", "gif"] as const).map((output) => <Button key={output}
          icon={output === "gif" ? <FileGifOutlined /> : <VideoCameraOutlined />}
          disabled={busy || savingDuration || !!preview || (output === "gif" ? !caps.formats.gif : !caps.formats.video.includes(output))}
          onClick={() => void run(output)}>{text("record")} · {output.toUpperCase()}</Button>)}
      </Space>
    </Space>
  </div>;
  return <>
    {panelTarget && createPortal(panel, panelTarget)}
    <Modal open={!!preview} title={text("recordingPreview")} className="capture-recording-modal" onCancel={closePreview} width={960}
      closable={!saving && !copying} maskClosable={!saving && !copying} keyboard={!saving && !copying}
      footer={<Space><Button onClick={closePreview} disabled={saving || copying}>{text("close")}</Button>
        {capture.copy && <Button icon={<CopyOutlined />} loading={copying} disabled={saving} onClick={() => void copy()}>
          {text('copyToClipboard')}</Button>}
        <Button type="primary" icon={<DownloadOutlined />} loading={saving} disabled={copying} onClick={() => void save()}>{text("download")}</Button></Space>}>
      {preview && <RecordingPreview result={preview.result} url={preview.url} text={text} />}
    </Modal>
  </>;
};
