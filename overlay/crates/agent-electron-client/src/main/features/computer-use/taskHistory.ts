import type { CuaRuntime, CuaTaskHistory, CuaTaskRuntime } from "@shared/features/computer-use/contract";

const terminal = new Set(["completed", "stopped", "failed"]);
const limit = 100;
/** Local display summaries only. No lease, native target ID, input or screenshot is restorable. */
export function createCuaTaskHistory(read: () => unknown, write: (rows: CuaTaskHistory[]) => void) {
  const project = (value: unknown): CuaTaskHistory | null => {
    if (!value || typeof value !== "object") return null;
    const row = value as CuaTaskHistory;
    if (typeof row.taskId !== "string" || row.taskId.length > 100 || !terminal.has(row.phase) ||
        !Number.isFinite(row.startedAt) || !Number.isFinite(row.endedAt) || !Number.isFinite(row.stepCount)) return null;
    return { taskId: row.taskId, phase: row.phase, label: typeof row.label === "string" ? row.label.slice(0, 200) : "",
      startedAt: row.startedAt, endedAt: row.endedAt, stepCount: Math.max(0, Math.floor(row.stepCount)),
      ...(["window", "desktop"].includes(row.scopeKind ?? "") ? { scopeKind: row.scopeKind } : {}),
      ...(["background", "foreground"].includes(row.mode ?? "") ? { mode: row.mode } : {}) };
  };
  let saved: CuaTaskHistory[] = [];
  try { const raw = read(); if (Array.isArray(raw)) saved = raw.slice(0, limit).map(project).filter((row): row is CuaTaskHistory => !!row).slice(0, limit); } catch { /* Missing summaries cannot block startup. */ }
  const seen = new Set(saved.map(row => row.taskId));
  const persist = () => { try { write(saved.map(row => ({ ...row }))); } catch { /* Display history cannot block task revocation or quit. */ } };
  return {
    list: () => saved.map(row => ({ ...row })),
    clear() { saved = []; persist(); },
    record(state: CuaRuntime) {
      let changed = false;
      for (const task of state.multiwindow ? state.tasks ?? [] : [state]) {
        if (!task.taskId || !terminal.has(task.phase) || task.controlPending || seen.has(task.taskId)) continue;
        const row = project({ taskId: task.taskId, phase: task.phase,
          label: task.scope?.kind === "window" ? task.scope.label : "", startedAt: task.startedAt ?? task.updatedAt,
          endedAt: task.updatedAt, stepCount: task.stepCount, scopeKind: task.scope?.kind,
          mode: state.multiwindow ? (task as CuaTaskRuntime).mode : undefined });
        if (!row) continue;
        seen.add(row.taskId); saved = [row, ...saved.filter(old => old.taskId !== row.taskId)].slice(0, limit); changed = true;
      }
      // Runtime keeps at most 32 tasks. Retain recent clear tombstones without unbounded growth.
      if (seen.size > 256) {
        const keep = new Set([...saved.map(row => row.taskId), ...(state.tasks ?? [state]).map(task => task.taskId)]);
        for (const id of seen) if (!keep.has(id)) seen.delete(id);
      }
      if (changed) persist();
    },
  };
}
