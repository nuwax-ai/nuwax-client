import type { PermissionSnapshot } from "@shared/types/permissionOnboarding";

type VisibleSnapshotWatch<T> = {
  read(): Promise<T | null>;
  update(snapshot: T): void;
  error(): void;
  document: Pick<
    Document,
    "hidden" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
};

/**
 * 页面可见时 1.5s 轮询 + focus/visibility 立即复查；隐藏或卸载丢弃迟到写入。
 * 授权清单使用。CU 设置页因 R1 不能引用本文件，自有一份同节奏实现。
 */
export function watchVisibleSnapshot<T>(options: VisibleSnapshotWatch<T>): () => void {
  let stopped = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let refreshPending = false;
  const refresh = async () => {
    if (stopped || options.document.hidden) return;
    if (busy) {
      refreshPending = true;
      return;
    }
    clearTimeout(timer);
    busy = true;
    const version = generation;
    try {
      const result = await options.read();
      if (!stopped && !options.document.hidden && version === generation) {
        if (result) options.update(result);
        else options.error();
      }
    } catch {
      if (!stopped && !options.document.hidden && version === generation)
        options.error();
    } finally {
      busy = false;
      if (!stopped && !options.document.hidden) {
        const immediate = refreshPending;
        refreshPending = false;
        timer = setTimeout(
          () => {
            void refresh();
          },
          immediate ? 0 : 1500,
        );
      }
    }
  };
  const onFocus = () => {
    void refresh();
  };
  const onVisibility = () => {
    generation++;
    clearTimeout(timer);
    if (!options.document.hidden) void refresh();
  };
  options.window.addEventListener("focus", onFocus);
  options.document.addEventListener("visibilitychange", onVisibility);
  void refresh();
  return () => {
    stopped = true;
    generation++;
    clearTimeout(timer);
    options.window.removeEventListener("focus", onFocus);
    options.document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** 授权页沿用原名，避免只改泛型就动所有调用点。 */
export function watchPermissionSnapshot(
  options: VisibleSnapshotWatch<PermissionSnapshot>,
): () => void {
  return watchVisibleSnapshot(options);
}
