/**
 * 「开源组件声明」弹窗。
 *
 * 形态取两家通行做法的长处：页首固定声明（飞书）+ 五列表格（微信：名称 / 版本号 / 许可证 /
 * 是否经过修改 / 源代码地址），并可点开许可证全文。数据来自安装包内由工具生成的清单，
 * 因此展示的永远是当前安装包实际携带的组件。
 *
 * 本文件不 import 客户端其余代码（特性边界）：翻译函数、桥、外链打开都由调用方传入。
 */

import React, { useEffect, useMemo, useState } from "react";
import { Input, Modal, Table } from "antd";
import type {
  NoticeComponent,
  NoticesBridge,
  NoticesDocument,
} from "@shared/features/open-source-notices/contract";
import { displayVersion, filterNotices, isSafeExternalUrl, sortNotices } from "./filter";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface OpenSourceNoticesModalProps {
  open: boolean;
  onClose: () => void;
  t: Translate;
  bridge: NoticesBridge | undefined;
  /** 用系统浏览器打开链接；由调用方保证走宿主的安全通道。 */
  openExternal: (url: string) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; doc: NoticesDocument };

function useNotices(open: boolean, bridge: NoticesBridge | undefined): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setState({ status: "loading" });
    (bridge?.get() ?? Promise.resolve(null)).then((doc) => {
      if (cancelled) return;
      setState(doc && doc.components.length > 0 ? { status: "ready", doc } : { status: "empty" });
    });
    return () => {
      cancelled = true;
    };
  }, [open, bridge]);

  return state;
}

type LicenseView =
  | { id: string; name: string; status: "loading" }
  | { id: string; name: string; status: "missing" }
  | { id: string; name: string; status: "ready"; text: string };

export function OpenSourceNoticesModal(props: OpenSourceNoticesModalProps): React.ReactElement {
  const { open, onClose, t, bridge, openExternal } = props;
  const state = useNotices(open, bridge);
  const [query, setQuery] = useState("");
  const [license, setLicense] = useState<LicenseView | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setLicense(null);
    }
  }, [open]);

  const rows = useMemo(
    () => (state.status === "ready" ? sortNotices(filterNotices(state.doc.components, query)) : []),
    [state, query],
  );

  const showLicense = (component: NoticeComponent) => {
    const { id, name } = component;
    setLicense({ id, name, status: "loading" });
    (bridge?.getLicenseText(id) ?? Promise.resolve(null)).then((text) => {
      setLicense((current) =>
        current?.id === id
          ? text === null
            ? { id, name, status: "missing" }
            : { id, name, status: "ready", text }
          : current,
      );
    });
  };

  const columns = [
    { title: t("Claw.About.openSource.colName"), dataIndex: "name", key: "name", width: 220 },
    {
      title: t("Claw.About.openSource.colVersion"),
      key: "version",
      width: 120,
      render: (_: unknown, c: NoticeComponent) => displayVersion(c.version),
    },
    {
      title: t("Claw.About.openSource.colLicense"),
      key: "license",
      width: 200,
      render: (_: unknown, c: NoticeComponent) =>
        c.license && c.licenseText ? (
          <a onClick={() => showLicense(c)}>{c.license}</a>
        ) : (
          c.license ?? "-"
        ),
    },
    {
      title: t("Claw.About.openSource.colModified"),
      key: "modified",
      width: 120,
      render: (_: unknown, c: NoticeComponent) => (c.modified ? t("Claw.Common.yes") : t("Claw.Common.no")),
    },
    {
      title: t("Claw.About.openSource.colSource"),
      key: "source",
      render: (_: unknown, c: NoticeComponent) =>
        isSafeExternalUrl(c.sourceUrl) ? (
          <a onClick={() => openExternal(c.sourceUrl as string)}>{t("Claw.About.openSource.download")}</a>
        ) : (
          "-"
        ),
    },
  ];

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        width={920}
        title={t("Claw.About.openSource.title")}
        destroyOnClose
      >
        <p style={{ fontWeight: 600, margin: "0 0 8px" }}>{t("Claw.About.openSource.statement")}</p>
        <p style={{ margin: "0 0 12px", color: "var(--color-text-secondary)" }}>
          {t("Claw.About.openSource.intro")}
        </p>
        {state.status === "loading" && <p>{t("Claw.About.openSource.loading")}</p>}
        {state.status === "empty" && <p>{t("Claw.About.openSource.empty")}</p>}
        {state.status === "ready" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <Input.Search
                allowClear
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Claw.About.openSource.searchPlaceholder")}
                style={{ maxWidth: 320 }}
              />
              <span style={{ color: "var(--color-text-secondary)" }}>
                {t("Claw.About.openSource.count", { count: rows.length })}
              </span>
            </div>
            <Table<NoticeComponent>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={rows}
              pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
              scroll={{ y: 420 }}
            />
          </>
        )}
      </Modal>
      <Modal
        open={license !== null}
        onCancel={() => setLicense(null)}
        footer={null}
        width={760}
        title={license ? t("Claw.About.openSource.licenseTitle", { name: license.name }) : ""}
        destroyOnClose
      >
        {license?.status === "loading" && <p>{t("Claw.About.openSource.loading")}</p>}
        {license?.status === "missing" && <p>{t("Claw.About.openSource.licenseUnavailable")}</p>}
        {license?.status === "ready" && (
          <pre style={{ whiteSpace: "pre-wrap", maxHeight: 480, overflow: "auto", margin: 0 }}>
            {license.text}
          </pre>
        )}
      </Modal>
    </>
  );
}
