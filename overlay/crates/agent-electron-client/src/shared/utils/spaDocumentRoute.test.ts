import { describe, expect, it } from "vitest";
import { buildSpaDocumentUrl, isMicroAppDocumentPath, parseBusinessDocumentUrl, resolveSpaDocumentRestore, SPA_RESTORE_PREFIX } from "./spaDocumentRoute";

const origin = "https://business.example:8443";
describe("私有主站文档恢复协议", () => {
  it.each(["/repo", "/repo/", "/repo/doc/a", "/instant-message", "/instant-message/conversation/7", "/repo/doc/%E4%B8%AD%E6%96%87"])("识别业务页面 %s", (path) => {
    expect(isMicroAppDocumentPath(path)).toBe(true);
  });
  it.each(["/repository/a", "/repo/ws", "/repo/internal/session", "/repo/assets/a", "/repo/static/file", "/instant-message/ws", "/instant-message/assets/file", "/repo/a.js", "/repo/%69nternal/a", "/repo/%2e%2e/api", "/repo/%5cinternal", "/repo/%zz", "/api/repo/a"])("排除业务接口及资源 %s", (path) => {
    expect(isMicroAppDocumentPath(path)).toBe(false);
  });
  it("完整往返查询、锚点、Unicode 和已有百分号编码，仅解码私有包装一次", () => {
    const target = new URL(`${origin}/repo/doc/a?file=%252F&mode=%25&_shell=1#title%20a`);
    const boot = buildSpaDocumentUrl(target);
    expect(new URL(boot).pathname).toBe("/home");
    expect(new URL(boot).search).toBe("");
    expect(resolveSpaDocumentRestore(boot)).toBe(target.pathname + target.search + target.hash);
  });
  it.each([
    `${origin}/repo${SPA_RESTORE_PREFIX}%2Frepo`,
    `${origin}/home?x=1${SPA_RESTORE_PREFIX}%2Frepo`,
    `${origin}/home${SPA_RESTORE_PREFIX}%2F%2Fevil.example%2Frepo`,
    `${origin}/home${SPA_RESTORE_PREFIX}https%3A%2F%2Fevil.example%2Frepo`,
    `${origin}/home${SPA_RESTORE_PREFIX}%2Fapi%2Fuser`,
    `${origin}/home${SPA_RESTORE_PREFIX}%2Frepo%2Fassets%2Fapp.js`,
    `${origin}/home${SPA_RESTORE_PREFIX}%zz`,
    `file:///home${SPA_RESTORE_PREFIX}%2Frepo`,
    `https://user:pass@business.example:8443/home${SPA_RESTORE_PREFIX}%2Frepo`,
  ])("拒绝错误标记 %s", (href) => expect(resolveSpaDocumentRestore(href)).toBeNull());
  it("只接受当前完整业务 origin", () => {
    expect(parseBusinessDocumentUrl("https://business.example/repo", origin)).toBeNull();
    expect(parseBusinessDocumentUrl("http://business.example:8443/repo", origin)).toBeNull();
    expect(parseBusinessDocumentUrl("https://u:p@business.example:8443/repo", origin)).toBeNull();
  });
});
