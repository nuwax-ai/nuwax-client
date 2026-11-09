import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Select, Space, Typography } from "antd";
import type {
  AndroidBridge,
  AndroidDevice,
  AndroidStatus,
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
  const discover = () =>
    act(async () => {
      const result = await api!.discover(adbPath);
      if (!mounted.current) return;
      setDevices(result.devices);
      setSerial(undefined);
      if (result.error) setError(result.error);
      else {
        setAdbPath(result.adbPath);
        if (!result.devices.length) setError("noDevices");
      }
    });
  const errorKeys = new Set([
    "adbMissing",
    "adbFailed",
    "deviceOffline",
    "invalidPath",
    "loginRequired",
    "nodeMissing",
    "gatewayFailed",
    "cancelled",
    "noDevices",
    "invalidScreenshot",
  ]);
  return (
    <>
      <Row
        label={t("Claw.Android.adbPath")}
        desc={t("Claw.Android.setup")}
        control={
          <Space>
            <Input
              aria-label={t("Claw.Android.adbPath")}
              placeholder={t("Claw.Android.pathPlaceholder")}
              value={adbPath}
              disabled={busy || status.enabled}
              onChange={(event) => {
                setAdbPath(event.target.value);
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
              {t("Claw.Android.refresh")}
            </Button>
          </Space>
        }
      />
      <Row
        label={t("Claw.Android.device")}
        desc={
          status.enabled
            ? `${t("Claw.Android.controlling")} ${status.serial}`
            : t("Claw.Android.deviceHint")
        }
        control={
          <Select
            aria-label={t("Claw.Android.device")}
            style={{ minWidth: 250 }}
            value={status.enabled ? status.serial : serial}
            disabled={busy || status.enabled || !ready}
            placeholder={t("Claw.Android.selectDevice")}
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
        label={t("Claw.Android.title")}
        desc={t("Claw.Android.scope")}
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
              {t("Claw.Android.stop")}
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={!ready || busy || !serial}
              onClick={() => setConfirming(true)}
            >
              {t("Claw.Android.enable")}
            </Button>
          )
        }
      />
      {error && (
        <Alert
          type="warning"
          showIcon
          message={t(
            "Claw.Android.errors." +
              (errorKeys.has(error) ? error : "operationFailed"),
          )}
        />
      )}
      <Modal
        title={t("Claw.Android.confirmTitle")}
        open={confirming}
        confirmLoading={busy}
        okText={t("Claw.Android.enable")}
        cancelText={t("Claw.Android.cancel")}
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
        <Typography.Paragraph>{t("Claw.Android.consent")}</Typography.Paragraph>
        <Typography.Text strong>
          {devices.find((device) => device.serial === serial)?.model} · {serial}
        </Typography.Text>
      </Modal>
    </>
  );
}
