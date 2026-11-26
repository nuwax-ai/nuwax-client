import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { AgentBrowserPage } from "./controller";
import {
  AgentWindowManager,
  type AgentWindowSource,
  type AgentWindowTabInfo,
} from "./windowManager";

type FakeTab = AgentWindowTabInfo & { contentsId: number };

function pageFor(tab: FakeTab): AgentBrowserPage {
  return {
    contents: { id: tab.contentsId } as unknown as WebContents,
    window: null,
    title: tab.title,
    url: tab.url,
    origin: new URL(tab.url).origin,
    active: tab.active,
    agentWindow: {
      sessionKey: "session-1",
      windowId: tab.windowId,
      tabId: tab.tabId,
    },
  };
}

function setup(options: {
  windowExists?: boolean;
  enabled?: () => boolean;
} = {}) {
  const tabs: FakeTab[] = [
    {
      windowId: "win-1",
      tabId: "tab-1",
      title: "One",
      url: "https://example.com/one",
      active: true,
      contentsId: 1,
    },
    {
      windowId: "win-1",
      tabId: "tab-2",
      title: "Two",
      url: "https://example.com/two",
      active: false,
      contentsId: 2,
    },
  ];
  let nextTab = 3;
  let active = true;
  let windowOpen = options.windowExists !== false;
  const own = (sessionKey: string) => sessionKey === "session-1" && windowOpen;
  const source: AgentWindowSource = {
    openAgentWindow: vi.fn((sessionKey: string, url: string) => {
      windowOpen = true;
      const tab: FakeTab = {
        windowId: "win-1",
        tabId: `tab-${nextTab}`,
        title: "",
        url,
        active: true,
        contentsId: nextTab++,
      };
      for (const item of tabs) item.active = false;
      tabs.push(tab);
      return tab;
    }),
    openAgentTab: vi.fn(
      (sessionKey: string, windowId: string | undefined, url: string) => {
        if (!own(sessionKey) || (windowId && windowId !== "win-1")) return null;
        const tab: FakeTab = {
          windowId: "win-1",
          tabId: `tab-${nextTab}`,
          title: "",
          url,
          active: true,
          contentsId: nextTab++,
        };
        for (const item of tabs) item.active = false;
        tabs.push(tab);
        return tab;
      },
    ),
    listAgentTabs: vi.fn((sessionKey: string, windowId?: string) => {
      if (!own(sessionKey) || (windowId && windowId !== "win-1")) return null;
      return {
        windowId: "win-1",
        tabs: tabs.map((tab) => ({ ...tab })),
      };
    }),
    switchAgentTab: vi.fn((sessionKey: string, tabId: string) => {
      if (!own(sessionKey)) return null;
      const tab = tabs.find((item) => item.tabId === tabId);
      if (!tab) return null;
      for (const item of tabs) item.active = item.tabId === tabId;
      return { ...tab, active: true };
    }),
    closeAgentTab: vi.fn(async () => ({ closed: false, requested: true })),
    closeAgentWindow: vi.fn(async () => ({
      closed: false,
      requested: true,
      cancelled: true,
    })),
    resolveOwnedAgentPage: vi.fn((sessionKey: string, tabId: string) => {
      if (!own(sessionKey)) return null;
      const tab = tabs.find((item) => item.tabId === tabId);
      return tab ? pageFor(tab) : null;
    }),
    agentWindowFor: vi.fn((sessionKey: string, windowId?: string) =>
      own(sessionKey) && (!windowId || windowId === "win-1")
        ? { windowId: "win-1", window: null }
        : null,
    ),
    isAgentOwnedPage: vi.fn(() => true),
  };
  const controller = {
    revokeOwner: vi.fn(),
    stateFor: vi.fn((contentsId: number) =>
      contentsId === 1 ? { controlled: true } : null,
    ),
  };
  const confirmAction = vi.fn(async () => true);
  const isActiveOwner = vi.fn(() => active);
  const manager = new AgentWindowManager({
    windows: source,
    enabled: options.enabled,
    confirmAction,
    isActiveOwner,
    controller,
    mainWindow: () => null,
  });
  const call = (
    tool: string,
    args: Record<string, unknown> = {},
    sessionKey = "session-1",
    signal = new AbortController().signal,
  ) =>
    manager.call({
      owner: "turn-1",
      sessionKey,
      conversationId: "conv-1",
      tool,
      args,
      signal,
    });
  return {
    manager,
    source,
    controller,
    confirmAction,
    isActiveOwner,
    call,
    tabs,
    setActive: (value: boolean) => {
      active = value;
    },
    closeWindow: () => {
      windowOpen = false;
    },
  };
}

describe("agent window URL confirmation", () => {
  it("shows the real URL before creating and loading a new window", async () => {
    const f = setup({ windowExists: false });
    const result = await f.call("nuwax_browser_open_window", {
      url: "https://example.com/start",
    });
    expect(f.confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "turn-1",
        conversationId: "conv-1",
        action: {
          kind: "open-window",
          origin: "https://example.com",
          url: "https://example.com/start",
        },
        page: expect.objectContaining({ origin: "https://example.com" }),
      }),
    );
    expect(
      f.confirmAction.mock.invocationCallOrder[0],
    ).toBeLessThan(f.source.openAgentWindow.mock.invocationCallOrder[0]);
    expect(f.source.openAgentWindow).toHaveBeenCalledWith(
      "session-1",
      "https://example.com/start",
    );
    expect(result.structured).toMatchObject({
      windowId: "win-1",
      tabId: "tab-3",
      active: true,
    });
  });

  it.each([
    "file:///tmp/page.html",
    "javascript:alert(1)",
    "https://user:password@example.com/",
    "about:blank",
  ])("rejects a non-ordinary URL before confirmation: %s", async (url) => {
    const f = setup();
    await expect(
      f.call("nuwax_browser_open_window", { url }),
    ).rejects.toMatchObject({ code: "invalidUrl" });
    expect(f.confirmAction).not.toHaveBeenCalled();
    expect(f.source.openAgentWindow).not.toHaveBeenCalled();
  });

  it("rejects a non-string URL", async () => {
    const f = setup();
    await expect(
      f.call("nuwax_browser_open_window", { url: 42 }),
    ).rejects.toMatchObject({ code: "invalidArguments" });
    expect(f.confirmAction).not.toHaveBeenCalled();
  });

  it("does not create a window when the user declines", async () => {
    const f = setup();
    f.confirmAction.mockResolvedValueOnce(false);
    await expect(
      f.call("nuwax_browser_open_window", {
        url: "https://example.com/start",
      }),
    ).rejects.toMatchObject({ code: "confirmationDenied" });
    expect(f.source.openAgentWindow).not.toHaveBeenCalled();
  });

  it("does not create a window when the turn ends during confirmation", async () => {
    const f = setup();
    f.confirmAction.mockImplementationOnce(async () => {
      f.setActive(false);
      return true;
    });
    await expect(
      f.call("nuwax_browser_open_window", {
        url: "https://example.com/start",
      }),
    ).rejects.toMatchObject({ code: "notAuthorized" });
    expect(f.source.openAgentWindow).not.toHaveBeenCalled();
  });

  it("does not create a window for a late answer after cancellation", async () => {
    const f = setup();
    let answer: ((approved: boolean) => void) | null = null;
    f.confirmAction.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const abort = new AbortController();
    const pending = f.call(
      "nuwax_browser_open_window",
      { url: "https://example.com/start" },
      "session-1",
      abort.signal,
    );
    await vi.waitFor(() => expect(f.confirmAction).toHaveBeenCalledOnce());
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    answer!(true);
    await Promise.resolve();
    expect(f.source.openAgentWindow).not.toHaveBeenCalled();
  });
});

describe("agent window tabs", () => {
  it("opens a tab only in the existing own window and invalidates the old page", async () => {
    const f = setup();
    const result = await f.call("nuwax_browser_open_tab", {
      url: "https://example.com/new",
    });
    expect(f.controller.revokeOwner).toHaveBeenCalledWith(
      "turn-1",
      "tabSwitched",
    );
    expect(f.source.openAgentTab).toHaveBeenCalledWith(
      "session-1",
      undefined,
      "https://example.com/new",
    );
    expect(result.structured).toMatchObject({ tabId: "tab-3", active: true });
  });

  it("requires an own window for open_tab", async () => {
    const f = setup({ windowExists: false });
    await expect(
      f.call("nuwax_browser_open_tab", { url: "https://example.com/new" }),
    ).rejects.toMatchObject({ code: "noWindow" });
    expect(f.confirmAction).not.toHaveBeenCalled();
  });

  it("lists only own tabs and marks the authorized one", async () => {
    const f = setup();
    const result = await f.call("nuwax_browser_list_tabs");
    expect(f.source.listAgentTabs).toHaveBeenCalledWith("session-1", undefined);
    expect(result.structured).toMatchObject({
      windowId: "win-1",
      tabs: [
        { tabId: "tab-1", active: true, authorized: true },
        { tabId: "tab-2", active: false, authorized: false },
      ],
    });
  });

  it("does not list another session's window", async () => {
    const f = setup();
    await expect(
      f.call("nuwax_browser_list_tabs", {}, "session-2"),
    ).rejects.toMatchObject({ code: "noWindow" });
    expect(f.source.listAgentTabs).toHaveBeenCalledWith(
      "session-2",
      undefined,
    );
  });

  it("switches only own tabs and revokes the old page binding", async () => {
    const f = setup();
    const result = await f.call("nuwax_browser_switch_tab", {
      tabId: "tab-2",
    });
    expect(f.controller.revokeOwner).toHaveBeenCalledWith(
      "turn-1",
      "tabSwitched",
    );
    expect(f.source.switchAgentTab).toHaveBeenCalledWith("session-1", "tab-2");
    expect(result.structured).toMatchObject({ tabId: "tab-2", active: true });
  });

  it("does not revoke when the requested tab is already active", async () => {
    const f = setup();
    const result = await f.call("nuwax_browser_switch_tab", {
      tabId: "tab-1",
    });
    expect(f.controller.revokeOwner).not.toHaveBeenCalled();
    expect(f.source.switchAgentTab).not.toHaveBeenCalled();
    expect(result.structured).toMatchObject({ tabId: "tab-1", active: true });
  });

  it("rejects an unknown or another session's tab", async () => {
    const f = setup();
    await expect(
      f.call("nuwax_browser_switch_tab", { tabId: "tab-2" }, "session-2"),
    ).rejects.toMatchObject({ code: "unknownTab" });
    expect(f.source.switchAgentTab).not.toHaveBeenCalled();
  });

  it("reports a refused close instead of claiming the tab closed", async () => {
    const f = setup();
    const result = await f.call("nuwax_browser_close_tab", {
      tabId: "tab-1",
    });
    expect(f.controller.revokeOwner).toHaveBeenCalledWith(
      "turn-1",
      "tabClosed",
    );
    expect(result.structured).toMatchObject({
      tabId: "tab-1",
      closed: false,
      requested: true,
    });
    expect(result.text).toContain("not reported as closed");
  });

  it("closes an owned tab while its document is still unavailable", async () => {
    const f = setup();
    f.source.resolveOwnedAgentPage.mockReturnValue(null);
    f.source.closeAgentTab.mockResolvedValueOnce({
      closed: true,
      requested: false,
    });
    const result = await f.call("nuwax_browser_close_tab", {
      tabId: "tab-1",
    });
    expect(result.structured).toMatchObject({ closed: true, requested: false });
    expect(result.text).toContain("Closed tab");
  });
});

describe("agent window close and isolation", () => {
  it("reports a cancelled window close without claiming success", async () => {
    const f = setup();
    const result = await f.call("nuwax_browser_close_window");
    expect(f.controller.revokeOwner).toHaveBeenCalledWith(
      "turn-1",
      "tabClosed",
    );
    expect(result.structured).toMatchObject({
      windowId: "win-1",
      closed: false,
      requested: true,
      cancelled: true,
    });
    expect(result.text).toContain("cancelled");
  });

  it("reports a confirmed window close", async () => {
    const f = setup();
    f.source.closeAgentWindow.mockResolvedValueOnce({
      closed: true,
      requested: false,
    });
    const result = await f.call("nuwax_browser_close_window", {
      windowId: "win-1",
    });
    expect(result.structured).toMatchObject({ closed: true, requested: false });
    expect(result.text).toContain("Closed window");
  });

  it("never closes a user or another session's window", async () => {
    const f = setup();
    await expect(
      f.call("nuwax_browser_close_window", {}, "session-2"),
    ).rejects.toMatchObject({ code: "noWindow" });
    expect(f.source.closeAgentWindow).not.toHaveBeenCalled();
    expect(f.controller.revokeOwner).not.toHaveBeenCalled();
  });

  it("aborts a pending confirmation when its turn ends", async () => {
    const f = setup();
    let answer: ((approved: boolean) => void) | null = null;
    f.confirmAction.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.call("nuwax_browser_open_window", {
      url: "https://example.com/start",
    });
    await vi.waitFor(() => expect(f.confirmAction).toHaveBeenCalledOnce());
    f.manager.cancelOwner("turn-1");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    answer!(true);
    await Promise.resolve();
    expect(f.source.openAgentWindow).not.toHaveBeenCalled();
  });

  it("aborts every pending confirmation on a user stop", async () => {
    const f = setup();
    let answer: ((approved: boolean) => void) | null = null;
    f.confirmAction.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.call("nuwax_browser_open_window", {
      url: "https://example.com/start",
    });
    await vi.waitFor(() => expect(f.confirmAction).toHaveBeenCalledOnce());
    f.manager.cancelPending();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    answer!(true);
    await Promise.resolve();
    expect(f.source.openAgentWindow).not.toHaveBeenCalled();
  });

  it("refuses management when the browser feature is disabled", async () => {
    const f = setup({ enabled: () => false });
    await expect(
      f.call("nuwax_browser_open_window", {
        url: "https://example.com/start",
      }),
    ).rejects.toMatchObject({ code: "noWindow" });
    expect(f.confirmAction).not.toHaveBeenCalled();
    expect(f.source.openAgentWindow).not.toHaveBeenCalled();
  });

  it("requires an authenticated session key", async () => {
    const f = setup();
    await expect(
      f.manager.call({
        owner: "turn-1",
        sessionKey: null,
        conversationId: null,
        tool: "nuwax_browser_open_window",
        args: { url: "https://example.com/start" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "notAuthorized" });
  });

  it("serializes overlapping management calls for one session", async () => {
    const f = setup({ windowExists: false });
    let answer: ((approved: boolean) => void) | null = null;
    f.confirmAction.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const opening = f.call("nuwax_browser_open_window", {
      url: "https://example.com/start",
    });
    await vi.waitFor(() => expect(f.confirmAction).toHaveBeenCalledOnce());
    const listing = f.call("nuwax_browser_list_tabs");
    await Promise.resolve();
    expect(f.source.listAgentTabs).not.toHaveBeenCalled();
    answer!(true);
    await expect(opening).resolves.toBeTruthy();
    await expect(listing).resolves.toBeTruthy();
    expect(f.source.openAgentWindow).toHaveBeenCalledOnce();
    expect(f.source.listAgentTabs).toHaveBeenCalledOnce();
  });
});
