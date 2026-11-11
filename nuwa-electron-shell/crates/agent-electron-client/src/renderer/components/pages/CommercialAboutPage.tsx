import { I18N_KEYS } from "@shared/constants";
import React from "react";
import { Button } from "antd";
import { t } from "../../services/core/i18n";
import styles from "../../styles/components/AboutPage.module.css";
import AboutPage, { type AboutPageProps } from "./AboutPage";
import { useDistHandshake } from "../../hooks/useDistHandshake";

export default function CommercialAboutPage(props: AboutPageProps = {}) {
  const { snapshot: distSnap, checking: distChecking, observedAt, refresh: refreshDist } = useDistHandshake();

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
      {window.electronAPI?.app?.getDistHandshake ? (
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
    </div>
  );
}
