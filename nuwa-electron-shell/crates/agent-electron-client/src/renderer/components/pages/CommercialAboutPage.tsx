import { I18N_KEYS } from "@shared/constants";
/**
 * 在 AboutPage 之后追加「开源组件声明」入口，复用既有版本与更新展示。
 * 声明数据来自安装包内由工具生成的清单（见 features/open-source-notices）。
 */

import React, { useMemo, useState } from "react";
import { Button } from "antd";
import type { NoticesBridge } from "@shared/features/open-source-notices/contract";
import { t } from "../../services/core/i18n";
import styles from "../../styles/components/AboutPage.module.css";
import { OpenSourceNoticesModal } from "../../features/open-source-notices";
import AboutPage, { type AboutPageProps } from "./AboutPage";
import { useDistHandshake } from "../../hooks/useDistHandshake";

interface ElectronApiWithNotices {
  notices?: NoticesBridge;
  shell?: { openExternal?: (url: string) => Promise<unknown> };
  app?: { getDistHandshake?: (force?: boolean) => Promise<unknown> };
}

const electronApi = (): ElectronApiWithNotices | undefined =>
  (window as unknown as { electronAPI?: ElectronApiWithNotices }).electronAPI;

export default function CommercialAboutPage(props: AboutPageProps = {}) {
  const [open, setOpen] = useState(false);
  // 固定桥对象的引用：弹窗里的加载 effect 依赖它，引用每次渲染都变会导致反复加载
  const bridge = useMemo(() => electronApi()?.notices, []);

  const { snapshot: distSnap, checking: distChecking, observedAt, refresh: refreshDist } = useDistHandshake();

  const openExternal = (url: string) => {
    electronApi()
      ?.shell?.openExternal?.(url)
      ?.catch((error: unknown) => console.error("[CommercialAboutPage] openExternal failed:", error));
  };

  const distStateText = (): string => {
    if (!distSnap) return t(distChecking ? I18N_KEYS.DistCheck.LOADING : I18N_KEYS.DistCheck.STATE_UNKNOWN);
    const local = distSnap.bundled?.version ?? "-";
    const cloud = distSnap.cloud?.version ?? "-";
    switch (distSnap.relation) {
      case "match":
        return t(I18N_KEYS.DistCheck.STATE_MATCH, { version: local });
      case "different":
        return t(I18N_KEYS.DistCheck.STATE_DIFFERENT);
      case "behind":
        return t(I18N_KEYS.DistCheck.STATE_BEHIND, { local, cloud });
      case "ahead":
        return t(I18N_KEYS.DistCheck.STATE_AHEAD, { local, cloud });
      default:
        return t(I18N_KEYS.DistCheck.STATE_UNKNOWN);
    }
  };

  const distCheckedText = (): string | null => {
    if (!distSnap?.checkedAt) return null;
    const minutes = Math.max(
      1,
      Math.round((observedAt - distSnap.checkedAt) / 60_000),
    );
    return t(I18N_KEYS.DistCheck.CHECKED_AT, { minutes });
  };

  return (
    // 内容高度交给外层 app-content-body 滚动。这里不能收缩到视口高度，
    // 否则 AboutPage 的内容溢出会把末尾卡片和底部 padding 一起裁掉。
    <div style={{ display: "flex", flexDirection: "column", flex: "0 0 auto" }}>
      <AboutPage {...props} />
      {electronApi()?.app?.getDistHandshake ? (
        <div className={styles.group} style={{ flexShrink: 0 }}>
          <div className={styles.groupCard}>
            <div className={styles.row}>
              <div className={styles.rowInfo}>
                <div className={styles.rowLabel}>
                  {t(I18N_KEYS.DistCheck.LINK)}
                </div>
                <div className={styles.rowDesc}>
                  {distStateText()}
                  {distCheckedText() ? ` · ${distCheckedText()}` : ""}
                </div>
              </div>
              <div className={styles.rowControl}>
                <Button
                  size="small"
                  loading={distChecking}
                  onClick={() => void refreshDist()}
                >
                  {t(I18N_KEYS.DistCheck.REFRESH)}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className={styles.group} style={{ flexShrink: 0, marginBottom: 0 }}>
        <div className={styles.groupCard}>
          <div className={styles.row}>
            <div className={styles.rowInfo}>
              <div className={styles.rowLabel}>{t("Claw.About.openSource.link")}</div>
              <div className={styles.rowDesc}>{t("Claw.About.openSource.linkDesc")}</div>
            </div>
            <div className={styles.rowControl}>
              <Button size="small" onClick={() => setOpen(true)}>
                {t("Claw.About.openSource.view")}
              </Button>
            </div>
          </div>
        </div>
      </div>
      <OpenSourceNoticesModal
        open={open}
        onClose={() => setOpen(false)}
        t={t}
        bridge={bridge}
        openExternal={openExternal}
      />
    </div>
  );
}
