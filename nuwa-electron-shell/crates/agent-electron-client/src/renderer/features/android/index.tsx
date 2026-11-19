import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Select, Space, Typography } from "antd";
import {
  ANDROID_I18N_KEYS as text,
  ANDROID_PLATFORM_TOOLS_URL,
  type AndroidAdbInstallOffer,
  type AndroidBridge,
  type AndroidDevice,
  type AndroidStatus,
} from "@shared/features/android/contract";

type Row = React.ComponentType<{
  label: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
}>;
export function AndroidSettings({
  api,
  t,
  Row,
}: {
  api?: AndroidBridge;
  t(key: string): string;
  Row: Row;
}) {
  const [status, setStatus] = useState<AndroidStatus>({
    enabled: false,
    serial: null,
    adbPath: "",
  });
  const [adbPath, setAdbPath] = useState("");
  const [detectedPath, setDetectedPath] = useState("");
  const [installOffer, setInstallOffer] = useState<AndroidAdbInstallOffer>();
  const [installing, setInstalling] = useState(false);
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [serial, setSerial] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(false),
    lock = useRef(false),
    request = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (!api || lock.current) return;
      const revision = ++request.current;
      void api
        .status()
        .then((value) => {
          if (!mounted.current || revision !== request.current || lock.current)
            return;
          setStatus(value);
          setReady(true);
          if (value.error) setError(value.error);
        })
        .catch(() => {
          if (mounted.current && revision === request.current)
            setError("operationFailed");
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      mounted.current = false;
      ++request.current;
      clearInterval(timer);
    };
  }, [api]);
  const act = async (work: () => Promise<void>) => {
    if (!api || lock.current) return;
    lock.current = true;
    ++request.current;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      if (mounted.current) setError("operationFailed");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refreshDevices = async () => {
    const result = await api!.discover(adbPath);
    if (!mounted.current) return;
    setDevices(result.devices);
    setSerial(undefined);
    setDetectedPath(result.adbPath);
    if (result.install) setInstallOffer(result.install);
    else if (result.error) setError(result.error);
    else if (!result.devices.length) setError("noDevices");
  };
  const discover = () => act(refreshDevices);
  const installAdb = (offer: AndroidAdbInstallOffer) =>
    act(async () => {
      setInstallOffer(undefined);
      setInstalling(true);
      try {
        const result = await api!.install({ version: offer.version, acceptedTerms: true });
        if (!mounted.current) return;
        if (result.error) setError(result.error);
        else await refreshDevices();
      } finally {
        if (mounted.current) setInstalling(false);
      }
    });
  const errorKey = error as keyof typeof text.errors;
  return (
    <>
      <Row
        label={t(text.ADB_PATH)}
        desc={t(text.SETUP)}
        control={
          <Space>
            <Input
              aria-label={t(text.ADB_PATH)}
              placeholder={detectedPath || t(text.PATH_PLACEHOLDER)}
              value={adbPath}
              disabled={busy || status.enabled}
              onChange={(event) => {
                setAdbPath(event.target.value);
                setDetectedPath("");
                setDevices([]);
                setSerial(undefined);
              }}
            />
            <Button
              disabled={busy || status.enabled || !ready}
              loading={busy}
              onClick={() => {
                void discover();
              }}
            >
              {t(text.REFRESH)}
            </Button>
          </Space>
        }
      />
      <Row
        label={t(text.DEVICE)}
        desc={
          status.enabled
            ? `${t(text.CONTROLLING)} ${status.serial}`
            : t(text.DEVICE_HINT)
        }
        control={
          <Select
            aria-label={t(text.DEVICE)}
            style={{ minWidth: 250 }}
            value={status.enabled ? status.serial : serial}
            disabled={busy || status.enabled || !ready}
            placeholder={t(text.SELECT_DEVICE)}
            onChange={setSerial}
            options={devices.map((device) => ({
              value: device.serial,
              label: `${device.model} · ${device.serial} (${device.state})`,
              disabled: device.state !== "device",
            }))}
          />
        }
      />
      <Row
        label={t(text.TITLE)}
        desc={t(text.SCOPE)}
        control={
          status.enabled ? (
            <Button
              danger
              disabled={busy}
              onClick={() => {
                void act(async () => {
                  const value = await api!.stop();
                  if (mounted.current) {
                    setStatus(value);
                    setConfirming(false);
                  }
                });
              }}
            >
              {t(text.STOP)}
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={!ready || busy || (devices.length > 0 && !serial)}
              onClick={() => {
                if (serial) setConfirming(true);
                else void discover();
              }}
            >
              {t(text.ENABLE)}
            </Button>
          )
        }
      />
      {installing && (
        <Alert
          type="info"
          showIcon
          message={t(text.INSTALLING)}
          action={
            <Button size="small" onClick={() => void api!.stop().catch(() => undefined)}>
              {t(text.CANCEL)}
            </Button>
          }
        />
      )}
      <Modal
        title={t(text.INSTALL_TITLE)}
        open={!!installOffer}
        okText={t(text.INSTALL_ACCEPT)}
        cancelText={t(text.CANCEL)}
        onCancel={() => setInstallOffer(undefined)}
        onOk={() => {
          if (installOffer) void installAdb(installOffer);
        }}
      >
        <Typography.Paragraph>
          {t(text.INSTALL_DESC)}
          {installOffer && (
            <> Android SDK Platform-Tools {installOffer.version} · {(installOffer.bytes / 1048576).toFixed(1)} MiB.</>
          )}
        </Typography.Paragraph>
        <Typography.Link href={ANDROID_PLATFORM_TOOLS_URL} target="_blank" rel="noreferrer">
          {t(text.INSTALL_TERMS)}
        </Typography.Link>
      </Modal>
      {error && (
        <Alert
          type="warning"
          showIcon
          message={t(
            Object.prototype.hasOwnProperty.call(text.errors, errorKey)
              ? text.errors[errorKey]
              : text.errors.operationFailed,
          )}
        />
      )}
      <Modal
        title={t(text.CONFIRM_TITLE)}
        open={confirming}
        confirmLoading={busy}
        okText={t(text.ENABLE)}
        cancelText={t(text.CANCEL)}
        onCancel={() => {
          if (!busy) setConfirming(false);
        }}
        onOk={() => {
          void act(async () => {
            if (!serial) return;
            const value = await api!.enable({ adbPath, serial });
            if (mounted.current) {
              setStatus(value);
              setConfirming(false);
              if (value.error) setError(value.error);
            }
          });
        }}
      >
        <Typography.Paragraph>{t(text.CONSENT)}</Typography.Paragraph>
        <Typography.Text strong>
          {devices.find((device) => device.serial === serial)?.model} · {serial}
        </Typography.Text>
      </Modal>
    </>
  );
}
