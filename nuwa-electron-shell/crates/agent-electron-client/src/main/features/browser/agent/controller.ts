/**
 * Agent 浏览器控制器：用户授权的单个普通标签页 + 单会话 owner 绑定。
 *
 * 安全不变量：
 * - 授权对象是具体的 WebContents 与 origin，不是"浏览器"或"域名"；
 * - 只有当前仍注册为普通浏览器标签页（非支付/隔离窗口、非主界面、非工具栏）的页面可被控制；
 * - 跨源导航、新窗口、页面销毁、调试器断开、会话停止或 MCP 断线都会立即撤销；
 * - 动作按 owner 串行执行，每个动作最多发送一次；超时按 uncertain 处理且绝不重放。
 */
import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents } from "electron";
import type { BrowserAgentState } from "@shared/features/browser/contract";
import type { FeatureLogger } from "../../_kit/types";
import {
  attachDebugger,
  captureObservation,
  clickElement,
  detachDebugger,
  httpOrigin,
  navigateTo,
  scrollPage,
  typeIntoElement,
  type CdpGuard,
  type ObservationElement,
  type ObservationSnapshot,
  type ScrollDirection,
} from "./cdp";
import { AgentBrowserError, cancelled, invalidArguments } from "./errors";

export interface AgentBrowserPage {
  contents: WebContents;
  window: BrowserWindow | null;
  title: string;
  url: string;
  origin: string;
  active: boolean;
  /** Set only for pages in an agent-owned dedicated window. */
  agentWindow?: {
    sessionKey: string;
    windowId: string;
    tabId: string;
  } | null;
}

export interface AgentBrowserPageSource {
  /** User ordinary pages; must not include agent-owned windows. */
  list(): AgentBrowserPage[];
  resolve(contents: WebContents): AgentBrowserPage | null;
  activate?(contents: WebContents): boolean;
  /** Resolve a tab in the caller's own agent window by opaque tab id. */
  resolveOwnedTab?(
    sessionKey: string,
    tabId: string,
  ): AgentBrowserPage | null;
}

export interface AgentBrowserAuthorizationRequest {
  owner: string;
  conversationId: string | null;
  reason: string;
  pages: AgentBrowserPage[];
}

export type AgentBrowserConfirm = (
  request: AgentBrowserAuthorizationRequest,
) => Promise<number | null>;

export type AgentBrowserActionKind =
  | "click"
  | "type"
  | "navigate"
  | "open-window"
  | "open-tab";

export interface AgentBrowserAction {
  kind: AgentBrowserActionKind;
  origin: string;
  /** Navigate target; never contains typed text. */
  url?: string;
  /** Click/type role and accessible name for the user's decision. */
  element?: { role: string; name: string };
  submit?: boolean;
}

export interface AgentBrowserActionRequest {
  owner: string;
  conversationId: string | null;
  window: BrowserWindow | null;
  page: { title: string; url: string; origin: string };
  action: AgentBrowserAction;
}

/** One native approval per side-effecting action; false means the user declined. */
export type AgentBrowserActionConfirm = (
  request: AgentBrowserActionRequest,
) => Promise<boolean>;

export interface AgentToolOutcome {
  text: string;
  structured: Record<string, unknown>;
  image?: ObservationSnapshot["screenshot"];
}

export interface AgentBrowserControllerOptions {
  pages: AgentBrowserPageSource;
  confirm: AgentBrowserConfirm;
  confirmAction: AgentBrowserActionConfirm;
  /** Runtime feature switch; the browser can be disabled while a tab is bound. */
  enabled?: () => boolean;
  log?: FeatureLogger;
  actionTimeoutMs?: number;
  observationTtlMs?: number;
  writesPerObservation?: number;
}

interface Observation {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** Navigation epoch at capture time; any main-frame document navigation retires it. */
  epoch: number;
  url: string;
  origin: string;
  elements: Map<number, ObservationElement>;
  writesLeft: number;
}

export type RevokeReason =
  | "pageClosed"
  | "pageCrashed"
  | "crossOrigin"
  | "newWindow"
  | "debuggerDetached"
  | "actionTimeout"
  | "pageUnavailable"
  | "revokedByUser"
  | "releasedByAgent"
  | "sessionEnded"
  | "turnEnded"
  | "turnCancelled"
  | "tabSwitched"
  | "tabClosed"
  | "tabInactive"
  | "disconnected"
  | "featureDisabled";

interface Binding {
  owner: string;
  conversationId: string | null;
  contents: WebContents;
  window: BrowserWindow | null;
  origin: string;
  observation: Observation | null;
  /** Incremented on every main-frame document navigation start. */
  observationEpoch: number;
  /**
   * Observation-bound action currently running. Waiting for confirmation uses
   * this to abort the action as soon as the page document is replaced.
   */
  actionObservationId: string | null;
  actionDispatched: boolean;
  /** Observation is not an element action, but its snapshot must not cross a document. */
  actionAbortOnNavigation: boolean;
  revoked: RevokeReason | null;
  /** Per-authorization lease; old actions keep the old revoked lease. */
  lease: { id: string; revoked: boolean };
  busy: boolean;
  actionAbort: AbortController | null;
  cleanups: Array<() => void>;
}

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_OBSERVATION_TTL_MS = 60_000;
const DEFAULT_WRITES_PER_OBSERVATION = 3;

function strictArgs(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw invalidArguments();
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw invalidArguments();
  return args;
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
    throw invalidArguments(`${key} must be a non-empty string.`);
  return value;
}

function requiredIndex(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000)
    throw invalidArguments(`${key} must be an element index from the observation.`);
  return value as number;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller may have created this promise just before an abort; keep a
    // handler on it so its rejection is not reported as unhandled.
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function outcome(
  text: string,
  structured: Record<string, unknown>,
  image?: ObservationSnapshot["screenshot"],
): AgentToolOutcome {
  return { text, structured, ...(image ? { image } : {}) };
}

export class AgentBrowserController {
  private readonly byOwner = new Map<string, Binding>();
  private readonly byPage = new Map<number, Binding>();
  private readonly listeners = new Set<() => void>();
  private pendingAuthorization: {
    owner: string;
    controller: AbortController;
  } | null = null;
  private disposed = false;
  private readonly actionTimeoutMs: number;
  private readonly observationTtlMs: number;
  private readonly writesPerObservation: number;

  constructor(private readonly options: AgentBrowserControllerOptions) {
    this.actionTimeoutMs =
      options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.observationTtlMs =
      options.observationTtlMs ?? DEFAULT_OBSERVATION_TTL_MS;
    this.writesPerObservation =
      options.writesPerObservation ?? DEFAULT_WRITES_PER_OBSERVATION;
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stateFor(contentsId: number): BrowserAgentState | null {
    const binding = this.byPage.get(contentsId);
    return binding && !binding.revoked
      ? { controlled: true, origin: binding.origin }
      : null;
  }

  activeCount(): number {
    return this.byPage.size;
  }

  async requestAccess(
    owner: string,
    conversationId: string | null,
    reason: string,
    signal?: AbortSignal,
    target: { sessionKey?: string | null; tabId?: string } = {},
  ): Promise<AgentToolOutcome> {
    if (this.disposed || this.options.enabled?.() === false)
      throw new AgentBrowserError(
        "noPage",
        "The built-in browser is unavailable.",
      );
    const existing = this.byOwner.get(owner);
    if (existing && !existing.revoked) {
      let live = true;
      try {
        this.assertLive(existing);
      } catch {
        // The binding was revoked; continue with a fresh authorization.
        live = false;
      }
      if (live && this.byOwner.get(owner) === existing) {
        if (!target.tabId) return this.pageOutcome(existing);
        const owned = target.sessionKey
          ? this.options.pages.resolveOwnedTab?.(
              target.sessionKey,
              target.tabId,
            )
          : null;
        if (owned?.contents.id === existing.contents.id)
          return this.pageOutcome(existing);
        throw new AgentBrowserError(
          "pageBusy",
          "This session already controls a different tab. Call nuwax_browser_release_access first.",
        );
      }
    }

    let pages: AgentBrowserPage[];
    if (target.tabId !== undefined) {
      if (
        !target.sessionKey ||
        !this.options.pages.resolveOwnedTab
      )
        throw new AgentBrowserError(
          "notAuthorized",
          "tabId is only available for a tab in the agent's own window.",
        );
      const owned = this.options.pages.resolveOwnedTab(
        target.sessionKey,
        target.tabId,
      );
      if (!owned)
        throw new AgentBrowserError(
          "unknownTab",
          "The tabId is not a live tab in your own agent window. Use nuwax_browser_list_tabs.",
        );
      if (!owned.active)
        throw new AgentBrowserError(
          "tabInactive",
          "Switch to that tab before requesting access.",
        );
      pages = [owned];
    } else {
      // The legacy user-choice flow never mixes in agent-owned windows.
      pages = this.options.pages.list().filter((page) => !page.agentWindow);
    }
    pages = this.availablePages(pages);
    const candidates = pages.filter((page) => !this.byPage.has(page.contents.id));
    if (pages.length === 0)
      throw new AgentBrowserError(
        "noPage",
        "No ordinary user webpage tab is open. Use nuwax_browser_list_tabs and request access with your own tabId, or ask the user to open a page in the Nuwax browser.",
      );
    if (candidates.length === 0)
      throw new AgentBrowserError(
        "pageBusy",
        "Every open tab is already controlled by another agent session. Stop that session or release its tab first.",
      );
    if (this.pendingAuthorization)
      throw new AgentBrowserError(
        "busy",
        "Another authorization request is already waiting for the user.",
      );

    const pending = { owner, controller: new AbortController() };
    const onAbort = () =>
      pending.controller.abort(signal?.reason ?? cancelled());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    this.pendingAuthorization = pending;
    let choice: number | null;
    try {
      // Never show a consent dialog for a request that was already cancelled.
      pending.controller.signal.throwIfAborted();
      choice = await raceAbort(
        this.options.confirm({
          owner,
          conversationId,
          reason,
          pages: candidates,
        }),
        pending.controller.signal,
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.pendingAuthorization === pending) this.pendingAuthorization = null;
    }
    if (choice === null || choice < 0 || choice >= candidates.length)
      throw new AgentBrowserError(
        "denied",
        "The user did not authorize agent control of a browser tab.",
      );

    if (this.disposed || this.options.enabled?.() === false)
      throw new AgentBrowserError(
        "noPage",
        "The built-in browser was disabled before authorization completed.",
      );
    const chosen = candidates[choice]!;
    const current =
      target.tabId !== undefined && target.sessionKey
        ? this.options.pages.resolveOwnedTab?.(
            target.sessionKey,
            target.tabId,
          ) ?? null
        : this.options.pages.resolve(chosen.contents);
    if (!current || current.contents.id !== chosen.contents.id)
      throw new AgentBrowserError(
        "pageChanged",
        "The selected tab closed before authorization completed. Ask the user to try again.",
      );
    if (current.agentWindow && !current.active)
      throw new AgentBrowserError(
        "tabInactive",
        "The selected tab is no longer active. Switch to it and request access again.",
      );
    const origin = httpOrigin(current.url);
    if (!origin || origin !== httpOrigin(chosen.url) || origin !== chosen.origin)
      throw new AgentBrowserError(
        "pageChanged",
        "The selected tab navigated to another site before authorization completed. Ask the user to authorize it again.",
      );
    if (this.byPage.has(current.contents.id))
      throw new AgentBrowserError(
        "pageBusy",
        "The selected tab is already controlled by another agent session.",
      );

    const binding = this.bind(owner, conversationId, current, origin);
    try {
      attachDebugger(current.contents);
    } catch {
      this.revoke(binding, "debuggerDetached");
      throw new AgentBrowserError(
        "debuggerUnavailable",
        "The tab cannot be inspected. Close DevTools for this tab and ask the user to authorize it again.",
      );
    }
    const settledOrigin = httpOrigin(current.contents.getURL());
    if (!settledOrigin || settledOrigin !== origin) {
      this.revoke(binding, "crossOrigin");
      throw new AgentBrowserError(
        "pageChanged",
        "The tab left the authorized site while access was being granted. Ask the user to authorize it again.",
      );
    }
    this.options.pages.activate?.(current.contents);
    this.options.log?.info?.("[AgentBrowser] control granted", {
      origin,
    });
    return this.pageOutcome(binding);
  }

  async call(
    owner: string,
    conversationId: string | null,
    tool: string,
    rawArgs: unknown,
    signal?: AbortSignal,
    sessionKey: string | null = null,
  ): Promise<AgentToolOutcome> {
    if (this.disposed || this.options.enabled?.() === false)
      throw new AgentBrowserError(
        "noPage",
        "The built-in browser is unavailable.",
      );
    switch (tool) {
      case "nuwax_browser_request_access": {
        const args = strictArgs(rawArgs, ["reason", "tabId"]);
        const reason =
          args.reason === undefined
            ? ""
            : typeof args.reason === "string"
              ? args.reason.replace(/[\r\n]+/g, " ").slice(0, 500)
              : (() => {
                  throw invalidArguments("reason must be a string.");
                })();
        if (
          args.tabId !== undefined &&
          (typeof args.tabId !== "string" ||
            args.tabId.length === 0 ||
            args.tabId.length > 128)
        )
          throw invalidArguments("tabId must be an opaque tab id.");
        return this.requestAccess(owner, conversationId, reason, signal, {
          sessionKey,
          tabId: args.tabId as string | undefined,
        });
      }
      case "nuwax_browser_release_access": {
        strictArgs(rawArgs, []);
        const binding = this.byOwner.get(owner);
        if (!binding)
          return outcome("No tab is currently authorized for this session.", {
            released: false,
          });
        this.revoke(binding, "releasedByAgent");
        return outcome("Agent browser control released.", { released: true });
      }
      default:
        break;
    }

    const binding = this.byOwner.get(owner);
    if (!binding)
      throw new AgentBrowserError(
        "noAuthorization",
        "No tab is authorized for this session. A previous authorization may have ended after navigation, a new tab, user stop or disconnect. Call nuwax_browser_request_access and wait for the user to allow a tab again.",
      );
    this.assertLive(binding);

    switch (tool) {
      case "nuwax_browser_observe": {
        const args = strictArgs(rawArgs, ["screenshot"]);
        if (args.screenshot !== undefined && typeof args.screenshot !== "boolean")
          throw invalidArguments("screenshot must be a boolean.");
        return this.observe(binding, signal, {
          screenshot: args.screenshot === true,
        });
      }
      case "nuwax_browser_click": {
        const args = strictArgs(rawArgs, ["observationId", "element"]);
        const observationId = requiredString(args, "observationId", 128);
        const elementIndex = requiredIndex(args, "element");
        const observation = this.checkObservation(binding, observationId);
        const element = this.elementAt(observation, elementIndex);
        await this.runAction(
          binding,
          signal,
          "click",
          async (_actionSignal, guard, mark) => {
            const current = this.checkObservation(binding, observationId);
            const target = this.elementAt(current, elementIndex);
            this.assertLive(binding);
            current.writesLeft--;
            guard.check();
            await clickElement(
              binding.contents,
              target.backendNodeId,
              guard,
              mark,
            );
          },
          {
            observationId,
            confirm: (actionSignal) => {
              // A navigation may have retired the observation before the dialog.
              this.checkObservation(binding, observationId);
              return this.confirmActionFor(
                binding,
                {
                  kind: "click",
                  origin: binding.origin,
                  element: { role: element.role, name: element.name },
                },
                actionSignal,
              );
            },
          },
        );
        return outcome(
          `Clicked element #${element.index}${element.name ? ` (${element.role} "${element.name}")` : ""} on ${binding.origin}.`,
          { clicked: element.index, url: binding.contents.getURL() },
        );
      }
      case "nuwax_browser_type": {
        const args = strictArgs(rawArgs, [
          "observationId",
          "element",
          "text",
          "submit",
        ]);
        const observationId = requiredString(args, "observationId", 128);
        const elementIndex = requiredIndex(args, "element");
        const observation = this.checkObservation(binding, observationId);
        const element = this.elementAt(observation, elementIndex);
        const text = requiredString(args, "text", 2000);
        if (text.includes("\u0000"))
          throw invalidArguments("text cannot contain NUL characters.");
        const submit = args.submit === true;
        if (args.submit !== undefined && typeof args.submit !== "boolean")
          throw invalidArguments("submit must be a boolean.");
        await this.runAction(
          binding,
          signal,
          "type",
          async (_actionSignal, guard, mark) => {
            const current = this.checkObservation(binding, observationId);
            const target = this.elementAt(current, elementIndex);
            this.assertLive(binding);
            current.writesLeft--;
            guard.check();
            await typeIntoElement(
              binding.contents,
              target.backendNodeId,
              text,
              submit,
              guard,
              mark,
            );
          },
          {
            observationId,
            // The confirmation shows the target field, never the typed text.
            confirm: (actionSignal) => {
              this.checkObservation(binding, observationId);
              return this.confirmActionFor(
                binding,
                {
                  kind: "type",
                  origin: binding.origin,
                  element: { role: element.role, name: element.name },
                  submit,
                },
                actionSignal,
              );
            },
          },
        );
        return outcome(
          `Typed into element #${element.index}${submit ? " and pressed Enter" : ""}.`,
          { element: element.index, submitted: submit, url: binding.contents.getURL() },
        );
      }
      case "nuwax_browser_scroll": {
        const args = strictArgs(rawArgs, [
          "observationId",
          "direction",
          "amount",
        ]);
        const observationId = requiredString(args, "observationId", 128);
        this.checkObservation(binding, observationId);
        const direction = args.direction;
        if (
          direction !== "up" &&
          direction !== "down" &&
          direction !== "left" &&
          direction !== "right"
        )
          throw invalidArguments("direction must be up, down, left or right.");
        if (args.amount !== undefined && typeof args.amount !== "number")
          throw invalidArguments("amount must be an integer.");
        const amount = args.amount === undefined ? 600 : args.amount;
        if (!Number.isSafeInteger(amount) || amount < 100 || amount > 2000)
          throw invalidArguments("amount must be between 100 and 2000.");
        await this.runAction(
          binding,
          signal,
          "scroll",
          async (_actionSignal, guard, mark) => {
            const current = this.checkObservation(binding, observationId);
            this.assertLive(binding);
            current.writesLeft--;
            guard.check();
            await scrollPage(
              binding.contents,
              direction as ScrollDirection,
              amount,
              guard,
              mark,
            );
          },
          { observationId, abortOnNavigation: true },
        );
        return outcome(`Scrolled ${direction} by ${amount}px.`, {
          direction,
          amount,
          url: binding.contents.getURL(),
        });
      }
      case "nuwax_browser_navigate": {
        const args = strictArgs(rawArgs, ["url"]);
        const raw = requiredString(args, "url", 2048);
        const target = this.navigationTarget(raw, binding.origin);
        await this.settleLoading(binding, signal);
        this.assertLive(binding);
        if (binding.contents.isLoading())
          throw new AgentBrowserError(
            "pageLoading",
            "The page is still loading. Observe it before another action.",
          );
        await this.runAction(
          binding,
          signal,
          "navigate",
          async (_actionSignal, guard, mark) => {
            this.assertLive(binding);
            // Re-check the destination after the user decision.
            const verified = this.navigationTarget(raw, binding.origin);
            guard.check();
            await navigateTo(binding.contents, verified, guard, mark);
          },
          {
            confirm: (actionSignal) =>
              this.confirmActionFor(
                binding,
                {
                  kind: "navigate",
                  origin: binding.origin,
                  url: target,
                },
                actionSignal,
              ),
          },
        );
        binding.observation = null;
        await this.settleLoading(binding, signal, 15_000).catch(() => undefined);
        this.assertLive(binding);
        return outcome(`Navigating to ${target}.`, {
          url: binding.contents.getURL(),
          loading: binding.contents.isLoading(),
        });
      }
      default:
        throw invalidArguments("Unknown browser tool.");
    }
  }

  cancelOwner(owner: string): void {
    this.byOwner
      .get(owner)
      ?.actionAbort?.abort(cancelled("The agent turn ended."));
    if (this.pendingAuthorization?.owner === owner)
      this.pendingAuthorization.controller.abort(
        cancelled("The agent turn ended."),
      );
  }

  revokeOwner(owner: string, reason: RevokeReason = "sessionEnded"): void {
    if (this.pendingAuthorization?.owner === owner)
      this.pendingAuthorization.controller.abort(
        cancelled("The agent session ended."),
      );
    const binding = this.byOwner.get(owner);
    if (binding) this.revoke(binding, reason);
  }

  revokePage(
    contents: WebContents,
    reason: RevokeReason = "revokedByUser",
  ): void {
    const binding = this.byPage.get(contents.id);
    if (binding) this.revoke(binding, reason);
  }

  /** A new window/tab was opened by this page; the destination needs fresh consent. */
  revokeOpener(contents: WebContents, reason: RevokeReason = "newWindow"): void {
    this.revokePage(contents, reason);
  }

  revokeAll(reason: RevokeReason = "featureDisabled"): void {
    for (const binding of [...this.byPage.values()]) this.revoke(binding, reason);
    this.pendingAuthorization?.controller.abort(
      cancelled("Authorization cancelled."),
    );
    this.pendingAuthorization = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.revokeAll("featureDisabled");
    this.disposed = true;
    this.listeners.clear();
  }

  private availablePages(input: AgentBrowserPage[]): AgentBrowserPage[] {
    const seen = new Set<number>();
    const pages: AgentBrowserPage[] = [];
    for (const page of input) {
      if (!page.contents || page.contents.isDestroyed()) continue;
      if (seen.has(page.contents.id)) continue;
      if (!httpOrigin(page.url)) continue;
      seen.add(page.contents.id);
      pages.push(page);
    }
    return pages;
  }

  private pageOutcome(binding: Binding): AgentToolOutcome {
    const title = binding.contents.getTitle() || "";
    const url = binding.contents.getURL();
    const page = this.options.pages.resolve(binding.contents);
    return outcome(
      `Authorized ${binding.origin}${title ? ` (${title})` : ""} for this agent session.`,
      {
        authorized: true,
        title,
        url,
        origin: binding.origin,
        conversationId: binding.conversationId,
        tabId: page?.agentWindow?.tabId ?? null,
        windowId: page?.agentWindow?.windowId ?? null,
      },
    );
  }

  private bind(
    owner: string,
    conversationId: string | null,
    page: AgentBrowserPage,
    origin: string,
  ): Binding {
    const binding: Binding = {
      owner,
      conversationId,
      contents: page.contents,
      window: page.window,
      origin,
      observation: null,
      observationEpoch: 0,
      actionObservationId: null,
      actionDispatched: false,
      actionAbortOnNavigation: false,
      revoked: null,
      lease: { id: randomUUID(), revoked: false },
      busy: false,
      actionAbort: null,
      cleanups: [],
    };
    this.byOwner.set(owner, binding);
    this.byPage.set(page.contents.id, binding);
    this.watch(binding);
    this.emit();
    return binding;
  }

  private watch(binding: Binding): void {
    const { contents } = binding;
    const navigateMainFrame = (url: string) => {
      if (httpOrigin(url) !== binding.origin) {
        this.revoke(binding, "crossOrigin");
        return;
      }
      // Any main-frame document navigation, including a same-origin same-URL
      // reload, replaces the document and retires the observed element refs.
      this.retireObservation(binding);
    };
    const onStart = (
      _event: unknown,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      // Same-document navigations keep the DOM; subframes never retire the page.
      if (!isMainFrame || isInPlace) return;
      navigateMainFrame(url);
    };
    const onRedirect = (
      _event: unknown,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      navigateMainFrame(url);
    };
    const onNavigate = (_event: unknown, url: string) => navigateMainFrame(url);
    const onDestroyed = () => this.revoke(binding, "pageClosed");
    const onGone = () => this.revoke(binding, "pageCrashed");
    const onNewWindow = () => this.revoke(binding, "newWindow");
    const onDetach = () => this.revoke(binding, "debuggerDetached");
    contents.on("did-start-navigation", onStart);
    contents.on("will-redirect", onRedirect);
    contents.on("did-redirect-navigation", onRedirect);
    contents.on("did-navigate", onNavigate);
    contents.once("destroyed", onDestroyed);
    contents.on("render-process-gone", onGone);
    contents.on("did-create-window", onNewWindow);
    contents.debugger.on("detach", onDetach);
    binding.cleanups.push(
      () => contents.removeListener("did-start-navigation", onStart),
      () => contents.removeListener("will-redirect", onRedirect),
      () => contents.removeListener("did-redirect-navigation", onRedirect),
      () => contents.removeListener("did-navigate", onNavigate),
      () => contents.removeListener("destroyed", onDestroyed),
      () => contents.removeListener("render-process-gone", onGone),
      () => contents.removeListener("did-create-window", onNewWindow),
      () => contents.debugger.removeListener("detach", onDetach),
    );
  }

  private assertLive(binding: Binding): void {
    if (binding.revoked)
      throw new AgentBrowserError(
        "reauthRequired",
        `Agent browser control ended (${binding.revoked}). Ask the user to authorize a tab again.`,
      );
    if (this.options.enabled?.() === false) {
      this.revoke(binding, "featureDisabled");
      throw new AgentBrowserError(
        "reauthRequired",
        "The built-in browser was disabled. Agent control ended.",
      );
    }
    if (binding.contents.isDestroyed() || binding.window?.isDestroyed()) {
      this.revoke(binding, "pageClosed");
      throw new AgentBrowserError(
        "reauthRequired",
        "The authorized tab closed. Ask the user to authorize a tab again.",
      );
    }
    const page = this.options.pages.resolve(binding.contents);
    if (!page) {
      this.revoke(binding, "pageUnavailable");
      throw new AgentBrowserError(
        "reauthRequired",
        "The authorized page is no longer an ordinary browser tab. Ask the user to authorize a tab again.",
      );
    }
    // Agent-owned windows only operate on the tab that is actually in front.
    if (page.agentWindow && !page.active) {
      this.revoke(binding, "tabInactive");
      throw new AgentBrowserError(
        "reauthRequired",
        "The agent tab is no longer active. Switch to it and request access again.",
      );
    }
    const origin = httpOrigin(binding.contents.getURL());
    if (!origin || origin !== binding.origin) {
      this.revoke(binding, "crossOrigin");
      throw new AgentBrowserError(
        "reauthRequired",
        "The page left the authorized site. Agent control ended; ask the user to authorize the destination tab again.",
      );
    }
    if (!binding.contents.debugger.isAttached()) {
      this.revoke(binding, "debuggerDetached");
      throw new AgentBrowserError(
        "reauthRequired",
        "The page inspection session ended. Ask the user to authorize the tab again.",
      );
    }
  }

  private checkObservation(binding: Binding, id: string): Observation {
    const observation = binding.observation;
    if (!observation || observation.id !== id)
      throw new AgentBrowserError(
        "observationRequired",
        "Observe the page first and use the observationId from that result.",
      );
    if (observation.epoch !== binding.observationEpoch) {
      binding.observation = null;
      throw new AgentBrowserError(
        "observationExpired",
        "The page navigated since that observation. Observe the page again.",
      );
    }
    if (Date.now() > observation.expiresAt) {
      binding.observation = null;
      throw new AgentBrowserError(
        "observationExpired",
        "The observation expired. Observe the page again.",
      );
    }
    if (observation.writesLeft <= 0)
      throw new AgentBrowserError(
        "observationRequired",
        "The observation's action allowance is used up. Observe the page again.",
      );
    if (
      observation.url !== binding.contents.getURL() ||
      observation.origin !== binding.origin
    ) {
      binding.observation = null;
      throw new AgentBrowserError(
        "observationExpired",
        "The page changed since that observation. Observe the page again.",
      );
    }
    return observation;
  }

  private guardFor(binding: Binding, signal: AbortSignal): CdpGuard {
    return {
      check: () => {
        if (binding.revoked || binding.lease.revoked)
          throw cancelled(
            `Agent browser control ended (${binding.revoked ?? "leaseRevoked"}).`,
          );
        if (this.byPage.get(binding.contents.id) !== binding)
          throw cancelled("Agent browser control ended.");
        const page = this.options.pages.resolve(binding.contents);
        if (!page) {
          this.revoke(binding, "pageUnavailable");
          throw cancelled("The authorized page is no longer available.");
        }
        // Never dispatch a step against a background tab in an agent window.
        if (page.agentWindow && !page.active) {
          this.revoke(binding, "tabInactive");
          throw cancelled("The agent tab is no longer active.");
        }
        signal.throwIfAborted();
      },
    };
  }

  private confirmActionFor(
    binding: Binding,
    action: AgentBrowserAction,
    signal: AbortSignal,
  ): Promise<boolean> {
    return raceAbort(
      this.options.confirmAction({
        owner: binding.owner,
        conversationId: binding.conversationId,
        window: binding.window,
        page: {
          title: binding.contents.getTitle() || "",
          url: binding.contents.getURL(),
          origin: binding.origin,
        },
        action,
      }),
      signal,
    );
  }

  private elementAt(observation: Observation, index: number): ObservationElement {
    const element = observation.elements.get(index);
    if (!element)
      throw new AgentBrowserError(
        "elementNotFound",
        "No element with that index exists in the observation. Observe the page again.",
      );
    return element;
  }

  private async observe(
    binding: Binding,
    signal?: AbortSignal,
    options: { screenshot?: boolean } = {},
  ): Promise<AgentToolOutcome> {
    const wantScreenshot = options.screenshot === true;
    return this.runAction(binding, signal, "observe", async (actionSignal, guard) => {
      const epoch = binding.observationEpoch;
      const observationGuard: CdpGuard = {
        check: () => {
          guard.check();
          if (binding.observationEpoch !== epoch)
            throw new AgentBrowserError(
              "observationExpired",
              "The page navigated during observation. Observe the page again.",
            );
        },
      };
      await this.settleLoading(binding, actionSignal, 5_000);
      actionSignal.throwIfAborted();
      observationGuard.check();
      this.assertLive(binding);
      const page = this.options.pages.resolve(binding.contents);
      // Text is always returned; a screenshot is an explicit opt-in only.
      const snapshot = await captureObservation(
        binding.contents,
        { screenshot: wantScreenshot },
        observationGuard,
      );
      observationGuard.check();
      actionSignal.throwIfAborted();
      this.assertLive(binding);
      const now = Date.now();
      const observation: Observation = {
        id: randomUUID(),
        createdAt: now,
        expiresAt: now + this.observationTtlMs,
        epoch,
        url: snapshot.url,
        origin: snapshot.origin,
        elements: new Map(
          snapshot.elements.map((element) => [element.index, element]),
        ),
        writesLeft: this.writesPerObservation,
      };
      binding.observation = observation;
      const outline =
        snapshot.tree || "(The accessibility tree is empty.)";
      const screenshotNote = wantScreenshot
        ? snapshot.screenshot
          ? "Screenshot attached. It supplements the outline; use only the numbered elements below."
          : "Screenshot requested but unavailable for this tab; rely on the outline below."
        : "Screenshot not requested. The text outline below is authoritative.";
      const header = [
        `Observation ${observation.id}`,
        `URL: ${snapshot.url}`,
        `Title: ${snapshot.title || "(none)"}`,
        `Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`,
        `Active tab: ${page?.active ? "yes" : "no"}`,
        `Actions left before the next observation: ${observation.writesLeft}`,
        screenshotNote,
        "Use only the numbered elements in this outline; never guess.",
        "",
      ].join("\n");
      return outcome(
        `${header}${outline}`,
        {
          observationId: observation.id,
          url: snapshot.url,
          title: snapshot.title,
          origin: snapshot.origin,
          viewport: snapshot.viewport,
          // The outline travels in structuredContent too: some MCP clients do
          // not surface text content to the model.
          outline,
          elements: snapshot.elements.length,
          actionsLeft: observation.writesLeft,
          expiresInMs: this.observationTtlMs,
          active: page?.active === true,
          screenshot: !!snapshot.screenshot,
        },
        snapshot.screenshot,
      );
    }, { abortOnNavigation: true });
  }

  private navigationTarget(raw: string, origin: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AgentBrowserError("invalidUrl", "The URL is invalid.");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new AgentBrowserError(
        "invalidUrl",
        "Only HTTP(S) URLs can be opened in the authorized tab.",
      );
    if (url.username || url.password)
      throw new AgentBrowserError(
        "invalidUrl",
        "URLs with embedded credentials are not allowed.",
      );
    if (url.origin !== origin)
      throw new AgentBrowserError(
        "crossOrigin",
        "Cross-site navigation needs a new user authorization. Ask the user to authorize the destination tab, then observe it.",
      );
    return url.href;
  }

  private async settleLoading(
    binding: Binding,
    signal?: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<void> {
    if (!binding.contents.isLoading()) return;
    await new Promise<void>((resolve) => {
      const events = ["did-stop-loading", "did-fail-load", "destroyed"];
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        for (const event of events)
          (binding.contents.removeListener as unknown as (
            name: string,
            listener: () => void,
          ) => void)(event, finish);
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      for (const event of events)
        (binding.contents.once as unknown as (
          name: string,
          listener: () => void,
        ) => void)(event, finish);
      if (signal?.aborted) finish();
    });
  }

  private async runAction<T>(
    binding: Binding,
    signal: AbortSignal | undefined,
    label: string,
    action: (
      actionSignal: AbortSignal,
      guard: CdpGuard,
      markDispatched: () => void,
    ) => Promise<T>,
    options: {
      mutating?: boolean;
      /** Observation-bound actions are aborted as soon as the document changes. */
      observationId?: string;
      /** Read-only observation waits must also not cross a document change. */
      abortOnNavigation?: boolean;
      confirm?: (actionSignal: AbortSignal) => Promise<boolean>;
    } = {},
  ): Promise<T> {
    if (binding.busy)
      throw new AgentBrowserError(
        "busy",
        "Another browser action is still running for this tab.",
      );
    binding.busy = true;
    binding.actionObservationId = options.observationId ?? null;
    binding.actionDispatched = false;
    binding.actionAbortOnNavigation = options.abortOnNavigation === true;
    const controller = new AbortController();
    const onOuterAbort = () =>
      controller.abort(signal?.reason ?? cancelled());
    if (signal?.aborted) onOuterAbort();
    else signal?.addEventListener("abort", onOuterAbort, { once: true });
    binding.actionAbort = controller;
    const guard = this.guardFor(binding, controller.signal);
    let dispatched = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.confirm) {
        // The native dialog has no action timeout; the user's decision is the
        // gate. A revoke aborts this race and ignores a late answer. Do not
        // open a dialog at all when the turn was already cancelled.
        controller.signal.throwIfAborted();
        const approved = await raceAbort(
          options.confirm(controller.signal),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (!approved)
          throw new AgentBrowserError(
            "confirmationDenied",
            "The user declined this browser action.",
          );
        // Page, owner and debugger must still match after the dialog.
        this.assertLive(binding);
        guard.check();
      }
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new AgentBrowserError(
            "uncertain",
            "The browser action did not confirm in time. It may have run; do not retry. Ask the user to authorize the tab again.",
            true,
          ),
        );
      }, this.actionTimeoutMs);
      const value = await raceAbort(
        action(controller.signal, guard, () => {
          dispatched = true;
          binding.actionDispatched = true;
        }),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      guard.check();
      return value;
    } catch (error) {
      if (
        error instanceof AgentBrowserError &&
        error.code === "confirmationDenied"
      )
        throw error;
      if (timedOut) {
        this.revoke(binding, "actionTimeout");
        throw new AgentBrowserError(
          "uncertain",
          `The ${label} action did not confirm in time. It may already have run; do not retry. Ask the user to authorize the tab again.`,
          true,
        );
      }
      if (controller.signal.aborted) {
        if (dispatched && options.mutating !== false)
          throw new AgentBrowserError(
            "uncertain",
            `The ${label} action was interrupted after it may have been sent. Do not retry; observe the page again.`,
            true,
          );
        // Preserve observationExpired for a navigation that retired the
        // observation; fall back to cancelled for transport/turn aborts.
        const reason = controller.signal.reason;
        if (reason instanceof AgentBrowserError) throw reason;
        throw cancelled();
      }
      if (error instanceof AgentBrowserError) {
        if (dispatched && options.mutating !== false && !error.uncertain)
          throw new AgentBrowserError(
            "uncertain",
            `The ${label} action was interrupted after it may have been sent. Do not retry; observe the page again.`,
            true,
          );
        throw error;
      }
      if (dispatched && options.mutating !== false)
        throw new AgentBrowserError(
          "uncertain",
          `The ${label} action may not have completed. Do not retry; observe the page again.`,
          true,
        );
      throw new AgentBrowserError(
        "pageUnavailable",
        `The ${label} action failed before it was sent.`,
      );
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
      if (binding.actionAbort === controller) binding.actionAbort = null;
      binding.actionObservationId = null;
      binding.actionDispatched = false;
      binding.actionAbortOnNavigation = false;
      binding.busy = false;
    }
  }

  private retireObservation(binding: Binding): void {
    binding.observation = null;
    binding.observationEpoch += 1;
    // A pending confirmation or a not-yet-dispatched action based on the old
    // document must stop immediately. A post-dispatch sequence completes so a
    // click can still release its mouse button.
    if (
      binding.actionAbortOnNavigation ||
      (binding.actionObservationId && !binding.actionDispatched)
    )
      binding.actionAbort?.abort(
        new AgentBrowserError(
          "observationExpired",
          "The page navigated before the action was sent. Observe the page again.",
        ),
      );
  }

  private revoke(binding: Binding, reason: RevokeReason): void {
    if (binding.revoked) return;
    binding.revoked = reason;
    // Old command sequences check this lease after every await; a new binding
    // on the same WebContents uses a different lease and cannot revive them.
    binding.lease.revoked = true;
    binding.actionAbort?.abort(cancelled(`Agent browser control ended (${reason}).`));
    for (const cleanup of binding.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* Listener removal must not block revocation. */
      }
    }
    binding.observation = null;
    if (this.byOwner.get(binding.owner) === binding)
      this.byOwner.delete(binding.owner);
    if (this.byPage.get(binding.contents.id) === binding)
      this.byPage.delete(binding.contents.id);
    detachDebugger(binding.contents);
    this.options.log?.info?.("[AgentBrowser] control ended", { reason });
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* A state observer must not affect revocation or authorization. */
      }
    }
  }
}
