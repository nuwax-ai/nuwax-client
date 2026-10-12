/**
 * 商业版「关于」页：在基座 `AboutPage` 之后追加「开源组件声明」一行（点击打开声明弹窗）。
 *
 * 为什么是组合而不是覆写：基座 `AboutPage.tsx` 有 790 行且由基座仓维护，整文件覆写会制造
 * 升级冲突面。这里只包一层、不改基座行为；`App.tsx` 里把 import 指向本文件即可。
 * 声明数据来自安装包内由工具生成的清单（见 features/open-source-notices）。
 */

import React, { useMemo, useState } from "react";
import { Button } from "antd";
import type { NoticesBridge } from "@shared/features/open-source-notices/contract";
import { t } from "../../services/core/i18n";
import styles from "../../styles/components/AboutPage.module.css";
import { OpenSourceNoticesModal } from "../../features/open-source-notices";
import AboutPage, { type AboutPageProps } from "./AboutPage";

interface ElectronApiWithNotices {
  notices?: NoticesBridge;
  shell?: { openExternal?: (url: string) => Promise<unknown> };
}

const electronApi = (): ElectronApiWithNotices | undefined =>
  (window as unknown as { electronAPI?: ElectronApiWithNotices }).electronAPI;

export default function CommercialAboutPage(props: AboutPageProps = {}) {
  const [open, setOpen] = useState(false);
  // 固定桥对象的引用：弹窗里的加载 effect 依赖它，引用每次渲染都变会导致反复加载
  const bridge = useMemo(() => electronApi()?.notices, []);

  const openExternal = (url: string) => {
    electronApi()
      ?.shell?.openExternal?.(url)
      ?.catch((error: unknown) => console.error("[CommercialAboutPage] openExternal failed:", error));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <AboutPage {...props} />
      <div className={styles.group} style={{ flexShrink: 0 }}>
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
