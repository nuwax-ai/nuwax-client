/**
 * 受控 CDP 动作集。
 *
 * 这里只提供固定的浏览器语义动作；模型永远拿不到 `sendCommand`、原始 CDP 方法名或
 * JavaScript 求值入口。所有坐标都由主进程根据元素的后端 DOM 节点计算，输入走
 * Chromium 输入管线而不是脚本注入。
 */
import type { WebContents } from "electron";
import { AgentBrowserError } from "./errors";

/**
 * Checked before and after every CDP await. Revocation flips the binding lease,
 * so a command sequence that lost the race cannot continue on a re-attached debugger.
 */
export interface CdpGuard {
  check(): void;
}

export interface ObservationElement {
  index: number;
  backendNodeId: number;
  role: string;
  name: string;
}

export interface ObservationSnapshot {
  title: string;
  url: string;
  origin: string;
  viewport: { width: number; height: number };
  elements: ObservationElement[];
  tree: string;
  screenshot?: { mimeType: string; data: string };
}

interface AxValue {
  value?: unknown;
}

interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name?: string; value?: AxValue }>;
}

interface BoxModel {
  content?: number[];
}

/** Only HTTP(S) pages with a real host can be authorized. */
export function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function attachDebugger(contents: WebContents): void {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  // Enable only the domains used by the fixed action set; never Runtime.
  for (const method of ["Page.enable", "Accessibility.enable", "DOM.enable"]) {
    try {
      void contents.debugger.sendCommand(method).catch(() => {});
    } catch {
      /* A concurrent detach is handled by the controller's detach listener. */
    }
  }
}

export function detachDebugger(contents: WebContents): void {
  try {
    if (!contents.isDestroyed() && contents.debugger.isAttached())
      contents.debugger.detach();
  } catch {
    /* The target may already be gone; revocation still stands. */
  }
}

async function command<T>(
  guard: CdpGuard,
  contents: WebContents,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  guard.check();
  if (contents.isDestroyed())
    throw new AgentBrowserError(
      "reauthRequired",
      "The page is no longer open.",
    );
  // The method name is chosen here, never by the model.
  const result = (await contents.debugger.sendCommand(
    method,
    params,
  )) as T;
  // A revocation during the await must stop the next step even when this debugger
  // was re-attached by a newer authorization.
  guard.check();
  return result;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

const NON_ACTIONABLE_ROLES = new Set([
  "StaticText",
  "InlineTextBox",
  "LineBreak",
  "none",
  "presentation",
]);

/**
 * Reduce Chromium's full AX tree to a compact, indented outline.
 * Element indices are deliberately local to one observation.
 */
export function flattenAxTree(
  nodes: AxNode[],
  maxElements = 300,
  maxLines = 400,
): { tree: string; elements: ObservationElement[] } {
  const byId = new Map<string, AxNode>();
  const referenced = new Set<string>();
  for (const node of nodes) {
    if (node.nodeId) byId.set(node.nodeId, node);
    for (const child of node.childIds ?? []) referenced.add(child);
  }
  let roots = nodes.filter(
    (node) => !!node.nodeId && !referenced.has(node.nodeId),
  );
  if (roots.length === 0) roots = nodes.filter((node) => !!node.nodeId);

  const lines: string[] = [];
  const elements: ObservationElement[] = [];
  const seen = new Set<string>();
  let nextIndex = 0;

  const walk = (node: AxNode, depth: number) => {
    if (lines.length >= maxLines || !node.nodeId || seen.has(node.nodeId))
      return;
    seen.add(node.nodeId);
    const role = text(node.role?.value) || "unknown";
    const name = text(node.name?.value);
    const value = text(node.value?.value);
    const description = text(node.description?.value);
    const ignored = node.ignored === true;
    const backendNodeId = node.backendDOMNodeId;
    let index: number | null = null;
    if (
      !ignored &&
      Number.isSafeInteger(backendNodeId) &&
      (backendNodeId ?? 0) > 0 &&
      !NON_ACTIONABLE_ROLES.has(role) &&
      elements.length < maxElements
    ) {
      index = nextIndex++;
      elements.push({ index, backendNodeId: backendNodeId!, role, name });
    }
    if (
      !ignored &&
      (name || value || description || index !== null || role === "StaticText")
    ) {
      const parts = [index !== null ? `[${index}]` : "   ", role];
      if (name) parts.push(JSON.stringify(name));
      if (value) parts.push(`value=${JSON.stringify(value)}`);
      if (description) parts.push(`description=${JSON.stringify(description)}`);
      lines.push(`${"  ".repeat(Math.min(depth, 12))}${parts.join(" ")}`);
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  return { tree: lines.join("\n").slice(0, 24_000), elements };
}

export async function captureObservation(
  contents: WebContents,
  options: { screenshot: boolean } = { screenshot: true },
  guard: CdpGuard,
): Promise<ObservationSnapshot> {
  let viewport = { width: 0, height: 0 };
  try {
    const metrics = await command<{
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>(guard, contents, "Page.getLayoutMetrics");
    const page = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    viewport = {
      width: Number(page.clientWidth) || 0,
      height: Number(page.clientHeight) || 0,
    };
  } catch (error) {
    guard.check();
    if (error instanceof AgentBrowserError && error.code === "cancelled")
      throw error;
    /* Dimension reporting is optional; the tree below is authoritative. */
  }

  const accessibility = await command<{ nodes?: AxNode[] }>(
    guard,
    contents,
    "Accessibility.getFullAXTree",
  );
  const { tree, elements } = flattenAxTree(accessibility?.nodes ?? []);
  let screenshot: ObservationSnapshot["screenshot"];
  if (options.screenshot) {
    try {
      const shot = await command<{ data?: string }>(
        guard,
        contents,
        "Page.captureScreenshot",
        {
          format: "jpeg",
          quality: 70,
          fromSurface: true,
          captureBeyondViewport: false,
        },
      );
      if (shot?.data)
        screenshot = { mimeType: "image/jpeg", data: shot.data };
    } catch (error) {
      guard.check();
      if (error instanceof AgentBrowserError && error.code === "cancelled")
        throw error;
      // A hidden tab may have no compositor frame; the AX tree still describes it.
    }
  }
  guard.check();
  const url = contents.getURL();
  return {
    title: contents.getTitle() || "",
    url,
    origin: httpOrigin(url) ?? "",
    viewport,
    elements,
    tree,
    screenshot,
  };
}

function nodeError(error: unknown): AgentBrowserError {
  const message = error instanceof Error ? error.message : String(error);
  return /no node|not found|does not exist|detached/i.test(message)
    ? new AgentBrowserError(
        "elementNotFound",
        "The observed element is no longer attached. Observe the page again.",
      )
    : new AgentBrowserError(
        "elementNotVisible",
        "The observed element cannot be clicked or focused. Observe the page again.",
      );
}

async function boxCenter(
  guard: CdpGuard,
  contents: WebContents,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  try {
    const model = await command<{ model?: BoxModel }>(
      guard,
      contents,
      "DOM.getBoxModel",
      { backendNodeId },
    );
    const quad = model?.model?.content;
    if (!quad || quad.length < 8)
      throw new AgentBrowserError(
        "elementNotVisible",
        "The observed element has no visible box. Observe the page again.",
      );
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const x = xs.reduce((sum, value) => sum + value, 0) / 4;
    const y = ys.reduce((sum, value) => sum + value, 0) / 4;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new AgentBrowserError(
        "elementNotVisible",
        "The observed element has no visible box. Observe the page again.",
      );
    return { x, y };
  } catch (error) {
    throw error instanceof AgentBrowserError ? error : nodeError(error);
  }
}

/** Marks the exact point after which a write may have reached the page. */
export type MarkDispatched = () => void;

export async function clickElement(
  contents: WebContents,
  backendNodeId: number,
  guard: CdpGuard,
  markDispatched: MarkDispatched,
): Promise<void> {
  try {
    await command(guard, contents, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId,
    });
  } catch (error) {
    guard.check();
    if (error instanceof AgentBrowserError && error.code === "cancelled")
      throw error;
    // The box lookup below reports detached/hidden elements with a stable code.
  }
  const { x, y } = await boxCenter(guard, contents, backendNodeId);
  await command(guard, contents, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  markDispatched();
  await command(guard, contents, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await command(guard, contents, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function pressEnter(guard: CdpGuard, contents: WebContents): Promise<void> {
  await command(guard, contents, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await command(guard, contents, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

export async function typeIntoElement(
  contents: WebContents,
  backendNodeId: number,
  value: string,
  submit: boolean,
  guard: CdpGuard,
  markDispatched: MarkDispatched,
): Promise<void> {
  try {
    await command(guard, contents, "DOM.focus", { backendNodeId });
  } catch (error) {
    guard.check();
    throw nodeError(error);
  }
  markDispatched();
  await command(guard, contents, "Input.insertText", { text: value });
  if (submit) await pressEnter(guard, contents);
}

export type ScrollDirection = "up" | "down" | "left" | "right";

export async function scrollPage(
  contents: WebContents,
  direction: ScrollDirection,
  amount: number,
  guard: CdpGuard,
  markDispatched: MarkDispatched,
): Promise<void> {
  let width = 0;
  let height = 0;
  try {
    const metrics = await command<{
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>(guard, contents, "Page.getLayoutMetrics");
    width = Number(metrics.cssLayoutViewport?.clientWidth) || 0;
    height = Number(metrics.cssLayoutViewport?.clientHeight) || 0;
  } catch (error) {
    guard.check();
    if (error instanceof AgentBrowserError && error.code === "cancelled")
      throw error;
    /* Fall back to a typical viewport centre. */
  }
  const x = Math.max(1, Math.round((width || 800) / 2));
  const y = Math.max(1, Math.round((height || 600) / 2));
  const deltaX =
    direction === "left" ? -amount : direction === "right" ? amount : 0;
  const deltaY =
    direction === "up" ? -amount : direction === "down" ? amount : 0;
  markDispatched();
  await command(guard, contents, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}

export async function navigateTo(
  contents: WebContents,
  url: string,
  guard: CdpGuard,
  markDispatched: MarkDispatched,
): Promise<void> {
  markDispatched();
  const result = await command<{ errorText?: string }>(
    guard,
    contents,
    "Page.navigate",
    { url },
  );
  if (result?.errorText)
    throw new AgentBrowserError(
      "navigationFailed",
      "The page rejected the navigation: " + result.errorText,
    );
}
