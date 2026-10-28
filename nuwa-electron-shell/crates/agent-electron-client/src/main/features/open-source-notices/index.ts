/**
 * 「开源组件声明」特性清单：向宿主壳渲染进程（「关于」页）提供声明数据与许可证全文。
 *
 * 数据由 `scripts/generate-third-party-notices.mjs` 在打包时生成并随包分发
 * （打包态 `resources/third-party/`，开发态 `third-party/generated/`），
 * 因此页面展示的永远是**当前安装包实际携带**的组件。
 */

import * as nodePath from "node:path";
import { app } from "electron";
import { NOTICES_IPC, type NoticesDocument } from "@shared/features/open-source-notices/contract";
import type { DesktopFeature, FeatureContext, FeatureHandle } from "../_kit/types";
import { createNoticesLoader, type NoticesLoader } from "./loader";

function candidateDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env.NUWAX_THIRD_PARTY_DIR;
  if (override) dirs.push(override);
  if (app.isPackaged) {
    dirs.push(nodePath.join(process.resourcesPath, "third-party"));
  } else {
    // 开发态：app 路径是 <repo>/nuwa-electron-shell/crates/agent-electron-client
    dirs.push(nodePath.resolve(app.getAppPath(), "../../../third-party/generated"));
  }
  return dirs;
}

export const openSourceNoticesFeature: DesktopFeature = {
  id: "open-source-notices",
  products: ["nuwax"],
  enabledByDefault: true,

  register(ctx: FeatureContext): FeatureHandle {
    // 懒创建：注册阶段不碰 electron，第一次有人读取声明时才解析目录
    let loader: NoticesLoader | null = null;
    const getLoader = (): NoticesLoader => (loader ??= createNoticesLoader(candidateDirs()));

    ctx.hostIpc.handle<unknown, [], NoticesDocument | null>(
      NOTICES_IPC.GET,
      () => getLoader().load(),
      null,
    );
    ctx.hostIpc.handle<unknown, [unknown], string | null>(
      NOTICES_IPC.GET_LICENSE_TEXT,
      (_event, id) => (typeof id === "string" ? getLoader().licenseText(id) : null),
      null,
    );

    return {
      dispose() {
        ctx.hostIpc.dispose();
      },
    };
  },
};
