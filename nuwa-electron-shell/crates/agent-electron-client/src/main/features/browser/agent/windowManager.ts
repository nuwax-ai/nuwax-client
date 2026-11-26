/**
 * Agent 专用浏览器窗口/页签管理。
 *
 * 与用户 shared 窗口、支付 isolated 窗口完全分开：每个认证会话至多一个本功能创建的
 * 专用窗口，窗口/页签 id 由宿主生成且不透明。身份只来自 MCP grant 的会话与回合，
 * 模型参数不能指定 owner；窗口操作只在当前活跃回合可用，迟到的确认不会创建或关闭。
 */
import type { BrowserWindow, WebContents } from "electron";
import type {
  AgentBrowserActionConfirm,
  AgentBrowserPage,
  AgentToolOutcome,
} from "./controller";
import { AgentBrowserError, cancelled, invalidArguments } from "./errors";
import { httpOrigin } from "./cdp";
import type { FeatureLogger } from "../../_kit/types";

export interface AgentWindowTabInfo {
  windowId: string;
  tabId: string;
  title: string;
  url: string;
  active: boolean;
}

export interface AgentWindowList {
  windowId: string;
  tabs: AgentWindowTabInfo[];
}

export interface AgentCloseResult {
  closed: boolean;
  requested: boolean;
  cancelled?: boolean;
}

export interface AgentWindowSource {
  openAgentWindow(sessionKey: string, url: string): AgentWindowTabInfo;
  openAgentTab(
    sessionKey: string,
    windowId: string | undefined,
    url: string,
  ): AgentWindowTabInfo | null;
  listAgentTabs(
    sessionKey: string,
    windowId?: string,
  ): AgentWindowList | null;
  switchAgentTab(
    sessionKey: string,
    tabId: string,
  ): AgentWindowTabInfo | null;
  closeAgentTab(
    sessionKey: string,
    tabId: string,
  ): Promise<AgentCloseResult | null>;
  closeAgentWindow(
    sessionKey: string,
    windowId?: string,
  ): Promise<AgentCloseResult | null>;
  resolveOwnedAgentPage(
    sessionKey: string,
    tabId: string,
  ): AgentBrowserPage | null;
  agentWindowFor(
    sessionKey: string,
    windowId?: string,
  ): { windowId: string; window: BrowserWindow | null } | null;
  isAgentOwnedPage(contents: WebContents): boolean;
}

export interface AgentWindowManagerOptions {
  windows: AgentWindowSource;
  /** Runtime browser feature switch. */
  enabled?: () => boolean;
  confirmAction: AgentBrowserActionConfirm;
  /** True only for the authenticated session's current active turn generation. */
  isActiveOwner(sessionKey: string, owner: string): boolean;
  controller: {
    revokeOwner(owner: string, reason: "tabSwitched" | "tabClosed"): void;
    stateFor(contentsId: number): { controlled: boolean; origin?: string } | null;
  };
  mainWindow(): BrowserWindow | null;
  log?: FeatureLogger;
}

export interface AgentWindowCall {
  owner: string;
  sessionKey: string | null;
  conversationId: string | null;
  tool: string;
  args: unknown;
  signal: AbortSignal;
}

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

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
    throw invalidArguments("Expected a non-empty string.");
  return value;
}

function optionalString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, maxLength);
}

/** Only HTTP(S), no embedded credentials, bounded length. */
function targetUrl(value: unknown): { url: string; origin: string } {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048)
    throw invalidArguments("url must be a non-empty HTTP(S) URL.");
  const origin = httpOrigin(value);
  if (!origin)
    throw new AgentBrowserError(
      "invalidUrl",
      "Only HTTP(S) URLs without embedded credentials are allowed.",
    );
  return { url: new URL(value).href, origin };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () =>
    signal.reason instanceof AgentBrowserError
      ? signal.reason
      : cancelled();
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
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
): AgentToolOutcome {
  return { text, structured };
}

export class AgentWindowManager {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<
    AbortController,
    { owner: string; sessionKey: string }
  >();

  constructor(private readonly options: AgentWindowManagerOptions) {}

  /** Stop button / lifecycle: abort every pending management confirmation. */
  cancelPending(): void {
    for (const controller of [...this.pending.keys()])
      controller.abort(
        cancelled("Agent window management was stopped by the user."),
      );
    this.pending.clear();
  }

  /** A turn ended or was cancelled: abort only that turn's pending confirms. */
  cancelOwner(owner: string): void {
    for (const [controller, meta] of [...this.pending])
      if (meta.owner === owner)
        controller.abort(cancelled("The agent turn ended."));
  }

  call(input: AgentWindowCall): Promise<AgentToolOutcome> {
    if (!input.sessionKey)
      return Promise.reject(
        new AgentBrowserError(
          "notAuthorized",
          "The agent session is not bound to this browser grant.",
        ),
      );
    const stop = new AbortController();
    this.pending.set(stop, {
      owner: input.owner,
      sessionKey: input.sessionKey,
    });
    const signal = AbortSignal.any([input.signal, stop.signal]);
    const result = this.serialized(input.sessionKey, () =>
      this.run({ ...input, signal }),
    );
    return result.finally(() => {
      this.pending.delete(stop);
    });
  }

  private serialized<T>(
    sessionKey: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(sessionKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(sessionKey, tail);
    void tail.then(() => {
      if (this.queues.get(sessionKey) === tail)
        this.queues.delete(sessionKey);
    });
    return next;
  }

  private assertActive(input: AgentWindowCall): void {
    if (this.options.enabled?.() === false)
      throw new AgentBrowserError(
        "noWindow",
        "The built-in browser is disabled.",
      );
    if (input.signal.aborted) {
      const reason = input.signal.reason;
      throw reason instanceof AgentBrowserError ? reason : cancelled();
    }
    if (
      !input.sessionKey ||
      !this.options.isActiveOwner(input.sessionKey, input.owner)
    )
      throw new AgentBrowserError(
        "notAuthorized",
        "The agent turn is no longer active; window management was refused.",
      );
  }

  private ownedTab(sessionKey: string, tabId: string): AgentWindowTabInfo | undefined {
    return this.options.windows.listAgentTabs(sessionKey)?.tabs.find((tab) => tab.tabId === tabId);
  }

  private async run(input: AgentWindowCall): Promise<AgentToolOutcome> {
    this.assertActive(input);
    const sessionKey = input.sessionKey!;
    switch (input.tool) {
      case "nuwax_browser_open_window": {
        const args = strictArgs(input.args, ["url"]);
        const target = targetUrl(args.url);
        const existing = this.options.windows.agentWindowFor(sessionKey);
        await this.confirmOpen(input, "open-window", target);
        this.assertActive(input);
        if (existing)
          this.options.controller.revokeOwner(input.owner, "tabSwitched");
        const tab = this.options.windows.openAgentWindow(
          sessionKey,
          target.url,
        );
        return this.openOutcome(
          tab,
          existing?.windowId !== tab.windowId,
          "Opened agent window",
        );
      }
      case "nuwax_browser_open_tab": {
        const args = strictArgs(input.args, ["url", "windowId"]);
        const target = targetUrl(args.url);
        const windowId = optionalString(args.windowId, 128);
        if (!this.options.windows.agentWindowFor(sessionKey, windowId))
          throw new AgentBrowserError(
            "noWindow",
            "No agent window is open. Call nuwax_browser_open_window first.",
          );
        await this.confirmOpen(input, "open-tab", target);
        this.assertActive(input);
        this.options.controller.revokeOwner(input.owner, "tabSwitched");
        const tab = this.options.windows.openAgentTab(
          sessionKey,
          windowId,
          target.url,
        );
        if (!tab)
          throw new AgentBrowserError(
            "noWindow",
            "The agent window closed before the new tab could be opened.",
          );
        return this.openOutcome(tab, false, "Opened agent tab");
      }
      case "nuwax_browser_list_tabs": {
        const args = strictArgs(input.args, ["windowId"]);
        const windowId = optionalString(args.windowId, 128);
        const list = this.options.windows.listAgentTabs(sessionKey, windowId);
        if (!list)
          throw new AgentBrowserError(
            "noWindow",
            "No agent window is open. Call nuwax_browser_open_window first.",
          );
        const tabs = list.tabs.map((tab) => {
          const page = this.options.windows.resolveOwnedAgentPage(
            sessionKey,
            tab.tabId,
          );
          return {
            ...tab,
            authorized:
              tab.active &&
              page !== null &&
              this.options.controller.stateFor(page.contents.id)?.controlled ===
                true,
          };
        });
        return outcome(
          `Agent window ${list.windowId} has ${tabs.length} tab(s).`,
          { windowId: list.windowId, tabs },
        );
      }
      case "nuwax_browser_switch_tab": {
        const args = strictArgs(input.args, ["tabId"]);
        const tabId = requiredString(args.tabId, 128);
        const page = this.ownedTab(sessionKey, tabId);
        if (!page)
          throw new AgentBrowserError(
            "unknownTab",
            "The tabId is not a live tab in your own agent window.",
          );
        if (page.active)
          return outcome(`Tab ${tabId} is already active.`, {
            windowId: page.windowId,
            tabId,
            active: true,
          });
        // Switching makes the old page/observation stale before activation.
        this.options.controller.revokeOwner(input.owner, "tabSwitched");
        const tab = this.options.windows.switchAgentTab(sessionKey, tabId);
        if (!tab)
          throw new AgentBrowserError(
            "unknownTab",
            "The tab could not be activated; the window may be closing.",
          );
        return outcome(
          `Switched to tab ${tab.tabId}. Previous page access is invalid; call nuwax_browser_request_access with this tabId.`,
          {
            windowId: tab.windowId,
            tabId: tab.tabId,
            url: tab.url,
            active: true,
          },
        );
      }
      case "nuwax_browser_close_tab": {
        const args = strictArgs(input.args, ["tabId"]);
        const tabId = requiredString(args.tabId, 128);
        const page = this.ownedTab(sessionKey, tabId);
        if (!page)
          throw new AgentBrowserError(
            "unknownTab",
            "The tabId is not a live tab in your own agent window.",
          );
        if (page.active)
          this.options.controller.revokeOwner(input.owner, "tabClosed");
        const result = await this.options.windows.closeAgentTab(
          sessionKey,
          tabId,
        );
        if (!result)
          throw new AgentBrowserError(
            "unknownTab",
            "The tab is no longer available in your own agent window.",
          );
        return this.closeOutcome("tab", tabId, result);
      }
      case "nuwax_browser_close_window": {
        const args = strictArgs(input.args, ["windowId"]);
        const windowId = optionalString(args.windowId, 128);
        const existing = this.options.windows.agentWindowFor(
          sessionKey,
          windowId,
        );
        if (!existing)
          throw new AgentBrowserError(
            "noWindow",
            "No agent window is open for this session.",
          );
        this.options.controller.revokeOwner(input.owner, "tabClosed");
        const result = await this.options.windows.closeAgentWindow(
          sessionKey,
          windowId,
        );
        if (!result)
          throw new AgentBrowserError(
            "noWindow",
            "The agent window is no longer available.",
          );
        return this.closeOutcome("window", existing.windowId, result);
      }
      default:
        throw invalidArguments("Unknown agent window tool.");
    }
  }

  private async confirmOpen(
    input: AgentWindowCall,
    kind: "open-window" | "open-tab",
    target: { url: string; origin: string },
  ): Promise<void> {
    const sessionKey = input.sessionKey!;
    const existing = this.options.windows.agentWindowFor(sessionKey);
    const approved = await raceAbort(
      this.options.confirmAction({
        owner: input.owner,
        conversationId: input.conversationId,
        window: existing?.window ?? this.options.mainWindow() ?? null,
        page: { title: "", url: target.url, origin: target.origin },
        action: { kind, origin: target.origin, url: target.url },
      }),
      input.signal,
    );
    if (!approved)
      throw new AgentBrowserError(
        "confirmationDenied",
        "The user declined opening this page.",
      );
  }

  private openOutcome(
    tab: AgentWindowTabInfo,
    created: boolean,
    label: string,
  ): AgentToolOutcome {
    return outcome(
      `${label}: window ${tab.windowId}, tab ${tab.tabId} (${tab.url}). Page access is not granted; call nuwax_browser_request_access with this tabId.`,
      {
        windowId: tab.windowId,
        tabId: tab.tabId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        created,
      },
    );
  }

  private closeOutcome(
    kind: "tab" | "window",
    id: string,
    result: AgentCloseResult,
  ): AgentToolOutcome {
    const structured = {
      [kind === "tab" ? "tabId" : "windowId"]: id,
      closed: result.closed,
      requested: result.requested,
      ...(result.cancelled === undefined
        ? {}
        : { cancelled: result.cancelled }),
    };
    const text = result.closed
      ? `Closed ${kind} ${id}.`
      : `Close requested for ${kind} ${id}, but it is still open${
          result.cancelled ? " (the user/page cancelled)" : " (beforeunload pending)"
        }. It was not reported as closed.`;
    return outcome(text, structured);
  }
}
