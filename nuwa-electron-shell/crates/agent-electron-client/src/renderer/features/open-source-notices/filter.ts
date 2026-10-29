/**
 * 「开源组件声明」列表的纯逻辑：搜索、排序、外链安全判断、展示格式。
 * 不依赖 React / Electron，可在 node 环境直接单测。
 */

import type { NoticeComponent } from "@shared/features/open-source-notices/contract";

/** 按名称 / 版本 / 许可证 / id 做不区分大小写的子串搜索；空查询返回全部。 */
export function filterNotices(
  components: readonly NoticeComponent[],
  query: string,
): NoticeComponent[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...components];
  return components.filter((c) =>
    [c.name, c.version ?? "", c.license ?? "", c.id].some((field) =>
      field.toLowerCase().includes(q),
    ),
  );
}

/** 先按名称（不区分大小写），再按版本排序；返回新数组。 */
export function sortNotices(components: readonly NoticeComponent[]): NoticeComponent[] {
  return [...components].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      (a.version ?? "").localeCompare(b.version ?? "", "en", { numeric: true }),
  );
}

/** 只允许打开不带凭据的 http(s) 链接，其余（含 javascript:、file:）一律拒绝。 */
export function isSafeExternalUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function displayVersion(version: string | null): string {
  return version && version.trim() ? version : "-";
}
