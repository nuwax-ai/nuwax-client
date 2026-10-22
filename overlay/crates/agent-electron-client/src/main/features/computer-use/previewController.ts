import type { CuaPreviewUpdate } from "@shared/features/computer-use/contract";

export interface PreviewIdentity { taskId: string; bindingId: string; epoch: number }
/** Display-only capture: no controller permits, observation credits, or frame queue. */
export function createCuaPreviewController(options: {
  identity: (id: string) => PreviewIdentity | null;
  capture: (id: string) => Promise<CuaPreviewUpdate>;
  publish: (update: CuaPreviewUpdate) => void;
}) {
  let selected: string | null = null, key = "", generation = 0, busy = false, disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const identityKey = () => selected ? JSON.stringify(options.identity(selected)) : "";
  const sync = () => {
    const next = identityKey();
    if (next !== key) {
      key = next; generation++;
      options.publish({ taskId: selected, status: next && next !== "null" ? "loading" : "ended" });
    }
  };
  const tick = async () => {
    if (disposed || !selected) return;
    sync();
    if (busy || !key || key === "null") return;
    busy = true;
    const id = selected, epoch = generation, identity = key;
    try {
      const result = await options.capture(id);
      sync();
      if (!disposed && selected === id && generation === epoch && key === identity) options.publish(result);
    } catch {
      if (!disposed && generation === epoch) options.publish({ taskId: id, status: "unavailable" });
    } finally { busy = false; }
  };
  const select = (id: string | null) => {
    if (disposed) return;
    if (selected === id && (timer || id === null)) { sync(); return; }
    if (selected !== id) { selected = id; key = ""; generation++; }
    if (timer) clearInterval(timer);
    timer = undefined;
    sync();
    if (id) { timer = setInterval(() => { void tick(); }, 500); timer.unref(); void tick(); }
    else options.publish({ taskId: null, status: "ended" });
  };
  return { select, sync, dispose() { select(null); disposed = true; generation++; } };
}
