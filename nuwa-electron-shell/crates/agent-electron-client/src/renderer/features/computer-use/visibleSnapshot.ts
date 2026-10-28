/**
 * CU 设置页自己的可见轮询。不能 import renderer/services（R1），
 * 算法与授权页 permissionPolling 对齐：可见 1.5s、focus 立即查、隐藏丢弃迟到写入。
 */
export type CuaVisibleWatch<T> = {
  read(): Promise<T | null>;
  update(snapshot: T): void;
  error(): void;
  document: Pick<
    Document,
    "hidden" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
};

export function watchCuaVisibleSnapshot<T>(options: CuaVisibleWatch<T>): () => void {
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
