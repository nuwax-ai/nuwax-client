/**
 * 观察元素索引：点击优先走最新快照的 element_index，坐标只在没有命中元素时保留。
 * 敏感控件硬拦复用 cuaSafety，不另起一套名单。
 */
import { isDeniedCuaApp, sensitiveUiRefusal, type CuaUiHaystack } from "./cuaSafety";

const INDEX_TOOLS = new Set(["click", "double_click", "right_click", "set_value", "scroll"]);
const OBSERVE_TOOLS = new Set(["get_window_state", "get_desktop_state", "get_accessibility_tree"]);

export type CuaObservedElement = {
  element_index: number;
  role?: string;
  label?: string;
  name?: string;
  title?: string;
  value?: string;
  description?: string;
  frame?: { x: number; y: number; w: number; h: number };
};

export type CuaObservationIndex = {
  snapshot_id?: string;
  app?: string;
  title?: string;
  elements: CuaObservedElement[];
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function asFinite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asIndex(value: unknown): number | undefined {
  const n = asFinite(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function readText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function frameOf(raw: Record<string, unknown>): CuaObservedElement["frame"] | undefined {
  const box = record(raw.frame) ?? record(raw.bounds) ?? record(raw.rect);
  const x = asFinite(box?.x ?? raw.x);
  const y = asFinite(box?.y ?? raw.y);
  const w = asFinite(box?.w ?? box?.width ?? raw.w ?? raw.width);
  const h = asFinite(box?.h ?? box?.height ?? raw.h ?? raw.height);
  if (x === undefined || y === undefined) return undefined;
  return { x, y, w: w ?? 0, h: h ?? 0 };
}

function indexOf(raw: Record<string, unknown>, fallback: number): number | undefined {
  const direct = asIndex(raw.element_index ?? raw.elementIndex ?? raw.index);
  if (direct !== undefined) return direct;
  const token = readText(raw.element_token, raw.elementToken);
  const matched = token?.match(/:(\d+)$/);
  if (matched) return Number(matched[1]);
  return fallback >= 0 ? fallback : undefined;
}

/** 兼容 helper 的 snake/camel 元素清单；缺 index 时用数组下标。 */
export function readObservationIndex(structured: unknown): CuaObservationIndex {
  const root = record(structured) ?? {};
  const list = Array.isArray(root.elements) ? root.elements
    : Array.isArray(root.nodes) ? root.nodes : [];
  const elements: CuaObservedElement[] = [];
  list.forEach((item, fallback) => {
    const raw = record(item);
    if (!raw) return;
    const element_index = indexOf(raw, fallback);
    if (element_index === undefined) return;
    elements.push({
      element_index,
      role: readText(raw.role, raw.ax_role, raw.axRole),
      label: readText(raw.label, raw.name, raw.title),
      name: readText(raw.name),
      title: readText(raw.title),
      value: readText(raw.value),
      description: readText(raw.description, raw.help),
      frame: frameOf(raw),
    });
  });
  return {
    snapshot_id: readText(root.snapshot_id, root.snapshotId),
    app: readText(root.app, root.app_name, root.appName, record(root.window)?.app),
    title: readText(root.title, root.window_title, record(root.window)?.title),
    elements,
  };
}

function pointOf(args: Record<string, unknown>): { x: number; y: number } | undefined {
  const x = asFinite(args.x);
  const y = asFinite(args.y);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function covers(frame: NonNullable<CuaObservedElement["frame"]>, point: { x: number; y: number }): boolean {
  if (frame.w <= 0 || frame.h <= 0) return false;
  return point.x >= frame.x && point.x <= frame.x + frame.w && point.y >= frame.y && point.y <= frame.y + frame.h;
}

function byIndex(elements: readonly CuaObservedElement[], index: number): CuaObservedElement | undefined {
  return elements.find((item) => item.element_index === index);
}

/** 坐标命中多个框时取面积最小的（更具体的控件）。 */
function byPoint(elements: readonly CuaObservedElement[], point: { x: number; y: number }): CuaObservedElement | undefined {
  let best: CuaObservedElement | undefined;
  let area = Infinity;
  for (const element of elements) {
    if (!element.frame || !covers(element.frame, point)) continue;
    const next = element.frame.w * element.frame.h;
    if (next < area) { best = element; area = next; }
  }
  return best;
}

export function findObservedElement(
  args: unknown,
  observation: CuaObservationIndex,
): CuaObservedElement | undefined {
  const raw = record(args) ?? {};
  const index = asIndex(raw.element_index ?? raw.elementIndex);
  if (index !== undefined) return byIndex(observation.elements, index);
  const token = readText(raw.element_token, raw.elementToken);
  const tokenIndex = token?.match(/:(\d+)$/);
  if (tokenIndex) return byIndex(observation.elements, Number(tokenIndex[1]));
  const point = pointOf(raw);
  return point ? byPoint(observation.elements, point) : undefined;
}

/**
 * 有稳定 index 就丢掉像素；只有坐标且最新观察能罩住该点时改写成 index。
 * 画布/游戏等无元素命中则原样保留 x/y，由后续 scope 决定是否放行。
 */
export function prepareCuaTargetedCall(
  tool: string,
  raw: unknown,
  observation: CuaObservationIndex,
): { tool: string; args: unknown; element?: CuaObservedElement; rewritten: boolean } {
  if (!INDEX_TOOLS.has(tool) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { tool, args: raw, rewritten: false };
  }
  const args = { ...raw } as Record<string, unknown>;
  const given = asIndex(args.element_index ?? args.elementIndex);
  if (given !== undefined) args.element_index = given;
  else {
    const token = readText(args.element_token, args.elementToken);
    const tokenIndex = token?.match(/:(\d+)$/);
    if (tokenIndex) args.element_index = Number(tokenIndex[1]);
  }
  const element = findObservedElement(args, observation);
  let rewritten = false;
  if (asIndex(args.element_index) !== undefined) {
    // 模型同时给了像素和 index 时，像素是猜测，index 才是观察通道。
    if (args.x !== undefined || args.y !== undefined) rewritten = true;
    delete args.x;
    delete args.y;
    delete args.elementIndex;
  } else if (element) {
    args.element_index = element.element_index;
    delete args.x;
    delete args.y;
    rewritten = true;
  }
  if (rewritten && !args.snapshot_id && observation.snapshot_id) args.snapshot_id = observation.snapshot_id;
  return { tool, args, element: element ?? (asIndex(args.element_index) !== undefined
    ? byIndex(observation.elements, args.element_index as number) : undefined), rewritten };
}

export function haystackForTarget(args: unknown, element?: CuaObservedElement): CuaUiHaystack {
  const raw = record(args) ?? {};
  return {
    role: element?.role,
    label: element?.label ?? readText(raw.label, raw.name, raw.title),
    name: element?.name ?? readText(raw.name),
    title: element?.title ?? readText(raw.title),
    value: element?.value,
    description: element?.description,
  };
}

/** 解析目标；命中密码栏 / 卡号栏 / 特权对话框则抛 sensitiveTarget。 */
export function resolveAndGuardCuaCall(
  tool: string,
  raw: unknown,
  observation: CuaObservationIndex,
): { tool: string; args: unknown } {
  const prepared = prepareCuaTargetedCall(tool, raw, observation);
  if (INDEX_TOOLS.has(tool) && isDeniedCuaApp([observation.app, observation.title])) {
    throw new Error("sensitiveTarget");
  }
  const denied = sensitiveUiRefusal(tool, prepared.args, haystackForTarget(prepared.args, prepared.element), {
    app: observation.app,
    title: observation.title,
  });
  if (denied) throw new Error(denied);
  return { tool: prepared.tool, args: prepared.args };
}

/** 每个会话各记一份最新观察，pause 后下一次写入仍会被 controller 要求先观察。 */
export class CuaElementIndex {
  private slots = new Map<string, CuaObservationIndex>();
  remember(owner: string, tool: string, outcome: string, structured: unknown) {
    if (outcome !== "ok" || !OBSERVE_TOOLS.has(tool)) return;
    this.slots.set(owner, readObservationIndex(structured));
  }
  forget(owner?: string) {
    if (owner === undefined) this.slots.clear();
    else this.slots.delete(owner);
  }
  latest(owner = ""): CuaObservationIndex {
    return this.slots.get(owner) ?? { elements: [] };
  }
}
