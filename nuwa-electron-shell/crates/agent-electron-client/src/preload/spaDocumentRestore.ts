import { resolveSpaDocumentRestore } from "@shared/utils/spaDocumentRoute";

/** 必须在业务脚本执行前同步运行；路由创建后再 replaceState 不会通知 Umi。 */
export function restoreSpaDocumentRoute(allowed: boolean, page: Window): boolean {
  if (!allowed || page.top !== page) return false;
  const target = resolveSpaDocumentRestore(page.location.href);
  if (!target) return false;
  page.history.replaceState(page.history.state, "", target);
  return true;
}
