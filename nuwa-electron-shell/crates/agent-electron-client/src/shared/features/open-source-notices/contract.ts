/**
 * 「开源组件声明」特性的公开契约（IPC 通道名 + 数据形状）。
 * main / preload / renderer 共用，不依赖 Electron 与任何业务模块。
 */

export const NOTICES_IPC = {
  GET: "notices:get",
  GET_LICENSE_TEXT: "notices:getLicenseText",
} as const;

export interface NoticeComponent {
  id: string;
  name: string;
  version: string | null;
  kind: "npm" | "binary" | "framework";
  /** `core` 或某个特性的 id。 */
  usedBy: string;
  /** SPDX 许可证表达式；读不到为 null。 */
  license: string | null;
  homepage: string | null;
  /** 该版本源代码的下载地址。 */
  sourceUrl: string | null;
  modified: boolean;
  /** 随包许可证全文的相对路径（`licenses/<id>.txt`）；没有为 null。 */
  licenseText: string | null;
  notes?: string | null;
}

export interface NoticesDocument {
  schema: number;
  components: NoticeComponent[];
}

/** 宿主壳渲染进程可见的桥形状（`window.electronAPI.notices`）。 */
export interface NoticesBridge {
  get(): Promise<NoticesDocument | null>;
  getLicenseText(id: string): Promise<string | null>;
}
