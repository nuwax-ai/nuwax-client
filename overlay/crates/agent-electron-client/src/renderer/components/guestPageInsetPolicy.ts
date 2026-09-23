/** 壳层顶行高度；需避让的 guest 页面与工具栏共用同一尺寸。 */
export const resolveHostToolbarHeight = (platform: string): number =>
  /mac/i.test(platform) ? 48 : 28;

/** 需要壳层顶部退让的整页；新增页面只需在此添加匹配规则。 */
const guestPageInsetRules: Array<(url: URL) => boolean> = [
  (url) => url.hostname === "pay.nuwax.com",
];

export const resolveGuestPageTopInset = (
  pageUrl: string,
  platform: string,
): number => {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return 0;
    return guestPageInsetRules.some((matches) => matches(url))
      ? resolveHostToolbarHeight(platform)
      : 0;
  } catch {
    return 0;
  }
};
