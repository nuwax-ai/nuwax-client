import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import {
  AgentBrowserController,
  type AgentBrowserPage,
} from "./controller";

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  behavior: Record<
    string,
    (params?: Record<string, unknown>) => Promise<unknown> | unknown
  > | null = null;
  attach = vi.fn(() => {
    if (this.attached) throw new Error("Debugger is already attached");
    this.attached = true;
  });
  detach = vi.fn(() => {
    this.attached = false;
  });
  isAttached = () => this.attached;
  sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    this.commands.push({ method, params });
    const override = this.behavior?.[method];
    if (override) return override(params);
    return this.fallback(method);
  });

  private fallback(method: string): unknown {
    switch (method) {
      case "Page.getLayoutMetrics":
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 700 } };
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "1",
              role: { value: "RootWebArea" },
              name: { value: "Example" },
              backendDOMNodeId: 1,
              childIds: ["2", "3"],
            },
            {
              nodeId: "2",
              role: { value: "button" },
              name: { value: "Submit" },
              backendDOMNodeId: 2,
              childIds: [],
            },
            {
              nodeId: "3",
              role: { value: "textbox" },
              name: { value: "Search" },
              backendDOMNodeId: 3,
              childIds: [],
            },
          ],
        };
      case "Page.captureScreenshot":
        return { data: "aGVsbG8=" };
      case "DOM.getBoxModel":
        return { model: { content: [10, 10, 110, 10, 110, 40, 10, 40] } };
      case "Page.navigate":
        return {};
      default:
        return {};
    }
  }
}

class FakeContents extends EventEmitter {
  id = 42;
  url = "https://example.com/page";
  title = "Example page";
  destroyed = false;
  loading = false;
  debugger = new FakeDebugger();
  getURL = () => this.url;
  getTitle = () => this.title;
  isDestroyed = () => this.destroyed;
  isLoading = () => this.loading;
}

const fakeWindow = () => ({
  isDestroyed: () => false,
  isMinimized: () => false,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
});

function setup(options: { actionTimeoutMs?: number } = {}) {
  const contents = new FakeContents();
  const win = fakeWindow();
  let page: AgentBrowserPage | null = {
    contents: contents as unknown as WebContents,
    window: win as unknown as BrowserWindow,
    title: contents.title,
    url: contents.url,
    origin: "https://example.com",
    active: true,
  };
  const source = {
    list: () => (page ? [page] : []),
    resolve: (candidate: WebContents) =>
      page && candidate === (contents as unknown as WebContents) ? page : null,
    activate: vi.fn(() => true),
  };
  const confirm = vi.fn(async () => 0);
  const confirmAction = vi.fn(async () => true);
  const controller = new AgentBrowserController({
    pages: source,
    confirm,
    confirmAction,
    actionTimeoutMs: options.actionTimeoutMs ?? 200,
  });
  const authorize = (owner = "owner-a") =>
    controller.call(owner, "conversation-1", "nuwax_browser_request_access", {
      reason: "test",
    });
  const observe = async (
    owner = "owner-a",
    args: Record<string, unknown> = {},
  ) => {
    const result = await controller.call(
      owner,
      "conversation-1",
      "nuwax_browser_observe",
      args,
    );
    return {
      ...result,
      observationId: String(result.structured.observationId),
    };
  };
  const click = (observationId: string, element: number, owner = "owner-a") =>
    controller.call(owner, "conversation-1", "nuwax_browser_click", {
      observationId,
      element,
    });
  return {
    contents,
    win,
    source,
    confirm,
    confirmAction,
    controller,
    authorize,
    observe,
    click,
    setPage: (next: AgentBrowserPage | null) => {
      page = next;
    },
  };
}

describe("AgentBrowserController authorization", () => {
  it("authorizes only the tab the user picked and attaches CDP", async () => {
    const f = setup();
    const result = await f.authorize();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.confirm.mock.calls[0][0].pages).toHaveLength(1);
    expect(f.contents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(f.source.activate).toHaveBeenCalledOnce();
    expect(result.structured).toMatchObject({
      authorized: true,
      origin: "https://example.com",
      conversationId: "conversation-1",
    });
    expect(f.controller.stateFor(f.contents.id)).toEqual({
      controlled: true,
      origin: "https://example.com",
    });
  });

  it("does not show the dialog when no ordinary tab is open", async () => {
    const f = setup();
    f.setPage(null);
    await expect(f.authorize()).rejects.toMatchObject({ code: "noPage" });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("treats dialog cancellation as denied and leaves no binding", async () => {
    const f = setup();
    f.confirm.mockResolvedValueOnce(null);
    await expect(f.authorize()).rejects.toMatchObject({ code: "denied" });
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
    expect(f.contents.debugger.attach).not.toHaveBeenCalled();
  });

  it("aborts a pending authorization when the session disconnects", async () => {
    const f = setup();
    let answer: ((choice: number | null) => void) | null = null;
    f.confirm.mockImplementationOnce(
      () =>
        new Promise<number | null>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.authorize();
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    f.controller.revokeOwner("owner-a", "disconnected");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    answer!(0);
    await Promise.resolve();
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
  });

  it("refuses a second owner while the tab is bound", async () => {
    const f = setup();
    await f.authorize("owner-a");
    await expect(f.authorize("owner-b")).rejects.toMatchObject({
      code: "pageBusy",
    });
    expect(f.confirm).toHaveBeenCalledOnce();
  });

  it("only lets the bound owner act", async () => {
    const f = setup();
    await f.authorize("owner-a");
    await expect(f.observe("owner-b")).rejects.toMatchObject({
      code: "noAuthorization",
    });
    await expect(f.observe("owner-a")).resolves.toMatchObject({
      structured: { origin: "https://example.com" },
    });
  });
});

describe("AgentBrowserController revocation", () => {
  it("ends control on cross-origin navigation and detaches the debugger", async () => {
    const f = setup();
    await f.authorize();
    f.contents.url = "https://other.example/";
    f.contents.emit(
      "did-start-navigation",
      { isMainFrame: true, isSameDocument: false },
      f.contents.url,
      false,
      true,
    );
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
    expect(f.contents.debugger.detach).toHaveBeenCalled();
    await expect(f.observe()).rejects.toMatchObject({
      code: "noAuthorization",
    });
  });

  it("keeps control on same-origin navigation but retires the old observation", async () => {
    const f = setup();
    await f.authorize();
    const stale = await f.observe();
    f.contents.url = "https://example.com/next";
    f.contents.emit(
      "did-start-navigation",
      { isMainFrame: true, isSameDocument: false },
      f.contents.url,
      false,
      true,
    );
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
    await expect(f.click(stale.observationId, 1)).rejects.toMatchObject({
      code: "observationRequired",
    });
    await expect(f.observe()).resolves.toBeTruthy();
  });

  it("retires the observation on a same-URL reload while keeping authorization", async () => {
    const f = setup();
    await f.authorize();
    const stale = await f.observe();
    f.contents.emit(
      "did-start-navigation",
      { isMainFrame: true, isSameDocument: false },
      f.contents.url,
      false,
      true,
    );
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
    await expect(f.click(stale.observationId, 1)).rejects.toMatchObject({
      code: "observationRequired",
    });
    expect(f.confirmAction).not.toHaveBeenCalled();
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);

    const current = await f.observe();
    await expect(f.click(current.observationId, 1)).resolves.toBeTruthy();
  });

  it("ignores subframe navigation for authorization and observations", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    f.contents.emit(
      "did-start-navigation",
      { isMainFrame: false, isSameDocument: false },
      "https://other.example/frame",
      false,
      false,
    );
    f.contents.emit(
      "will-redirect",
      { isMainFrame: false, isSameDocument: false },
      "https://other.example/frame",
      false,
      false,
    );
    f.contents.emit(
      "did-redirect-navigation",
      { isMainFrame: false, isSameDocument: false },
      "https://other.example/frame",
      false,
      false,
    );
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
    await expect(f.click(observationId, 1)).resolves.toBeTruthy();
  });

  it("ends control when the page opens a new window", async () => {
    const f = setup();
    await f.authorize();
    f.controller.revokeOpener(f.contents as unknown as WebContents, "newWindow");
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
    await expect(f.observe()).rejects.toMatchObject({
      code: "noAuthorization",
    });
  });

  it("ends control when the page is destroyed", async () => {
    const f = setup();
    await f.authorize();
    f.contents.destroyed = true;
    f.contents.emit("destroyed");
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
    await expect(f.observe()).rejects.toMatchObject({
      code: "noAuthorization",
    });
  });

  it("ends control when the debugger detaches", async () => {
    const f = setup();
    await f.authorize();
    f.contents.debugger.emit("detach", {}, "target closed");
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
    await expect(f.observe()).rejects.toMatchObject({
      code: "noAuthorization",
    });
  });

  it("ends control when the page is no longer an ordinary browser tab", async () => {
    const f = setup();
    await f.authorize();
    f.setPage(null);
    await expect(f.observe()).rejects.toMatchObject({
      code: "reauthRequired",
    });
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
  });

  it("revokes on user stop and on disconnect", async () => {
    const f = setup();
    await f.authorize();
    f.controller.revokePage(
      f.contents as unknown as WebContents,
      "revokedByUser",
    );
    expect(f.controller.stateFor(f.contents.id)).toBeNull();

    await f.authorize();
    f.controller.revokeOwner("owner-a", "disconnected");
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
  });
});

describe("AgentBrowserController controlled actions", () => {
  it("returns a text-only indexed outline in text and structuredContent by default", async () => {
    const f = setup();
    await f.authorize();
    const result = await f.observe();
    expect(result.observationId).toHaveLength(36);
    expect(result.structured).toMatchObject({
      origin: "https://example.com",
      elements: 3,
      screenshot: false,
    });
    expect(result.structured.outline).toContain('[1] button "Submit"');
    expect(result.structured.outline).toContain('[2] textbox "Search"');
    expect(result.image).toBeUndefined();
    expect(result.text).toContain('[1] button "Submit"');
    expect(result.text).toContain("Screenshot not requested.");
    const methods = f.contents.debugger.commands.map((item) => item.method);
    expect(methods).toContain("Accessibility.getFullAXTree");
    expect(methods).not.toContain("Page.captureScreenshot");
    expect(
      methods.some((method) =>
        /runtime|evaluate|javascript|addScript/i.test(method),
      ),
    ).toBe(false);
  });

  it("captures a screenshot only when explicitly requested", async () => {
    const f = setup();
    await f.authorize();
    const result = await f.observe("owner-a", { screenshot: true });
    expect(result.structured).toMatchObject({
      elements: 3,
      screenshot: true,
    });
    expect(result.structured.outline).toContain('[1] button "Submit"');
    expect(result.image).toEqual({
      mimeType: "image/jpeg",
      data: "aGVsbG8=",
    });
    expect(result.text).toContain('[1] button "Submit"');
    expect(result.text).toContain("Screenshot attached.");
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Page.captureScreenshot",
      ),
    ).toHaveLength(1);
  });

  it("rejects a non-boolean screenshot argument", async () => {
    const f = setup();
    await f.authorize();
    await expect(
      f.observe("owner-a", { screenshot: "yes" }),
    ).rejects.toMatchObject({ code: "invalidArguments" });
  });

  it("clicks an observed element through the input pipeline", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    const result = await f.click(observationId, 1);
    expect(result.structured).toMatchObject({ clicked: 1 });
    const mouse = f.contents.debugger.commands.filter(
      (item) => item.method === "Input.dispatchMouseEvent",
    );
    expect(mouse.map((item) => item.params?.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(mouse[1].params).toMatchObject({
      x: 60,
      y: 25,
      button: "left",
    });
  });

  it("requires a fresh observation after the write allowance", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    for (let index = 0; index < 3; index++)
      await expect(f.click(observationId, 1)).resolves.toBeTruthy();
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "observationRequired",
    });
  });

  it("rejects an element index that was not observed before dispatch", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    await expect(f.click(observationId, 99)).rejects.toMatchObject({
      code: "elementNotFound",
    });
    expect(
      f.contents.debugger.commands.some(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toBe(false);
  });

  it("types and optionally submits only through observed elements", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_type",
      { observationId, element: 2, text: "hello", submit: true },
    );
    const methods = f.contents.debugger.commands.map((item) => item.method);
    expect(methods).toContain("DOM.focus");
    expect(methods).toContain("Input.insertText");
    expect(
      f.contents.debugger.commands.find(
        (item) => item.method === "Input.insertText",
      )?.params,
    ).toEqual({ text: "hello" });
    expect(methods.filter((method) => method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });

  it("refuses cross-origin navigation without dispatching Page.navigate", async () => {
    const f = setup();
    await f.authorize();
    await expect(
      f.controller.call("owner-a", "conversation-1", "nuwax_browser_navigate", {
        url: "https://other.example/",
      }),
    ).rejects.toMatchObject({ code: "crossOrigin" });
    expect(
      f.contents.debugger.commands.some(
        (item) => item.method === "Page.navigate",
      ),
    ).toBe(false);
  });

  it("navigates same-origin once and invalidates the old observation", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    await expect(
      f.controller.call("owner-a", "conversation-1", "nuwax_browser_navigate", {
        url: "https://example.com/next",
      }),
    ).resolves.toBeTruthy();
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Page.navigate",
      ),
    ).toHaveLength(1);
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "observationRequired",
    });
  });

  it("scopes scrolling to the observed tab", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    await f.controller.call("owner-a", "conversation-1", "nuwax_browser_scroll", {
      observationId,
      direction: "down",
      amount: 400,
    });
    const wheel = f.contents.debugger.commands.find(
      (item) =>
        item.method === "Input.dispatchMouseEvent" &&
        item.params?.type === "mouseWheel",
    );
    expect(wheel?.params).toMatchObject({ deltaY: 400, x: 500, y: 350 });
  });

  it("rejects invalid arguments before touching the page", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    await expect(f.click(observationId, -1)).rejects.toMatchObject({
      code: "invalidArguments",
    });
    expect(
      f.contents.debugger.commands.some(
        (item) => item.method === "DOM.getBoxModel",
      ),
    ).toBe(false);
  });

  it("serializes actions for one owner", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.contents.debugger.behavior = {
      "Input.dispatchMouseEvent": async () => {
        await gate;
      },
    };
    const first = f.click(observationId, 1);
    await vi.waitFor(() =>
      expect(
        f.contents.debugger.commands.some(
          (item) => item.method === "Input.dispatchMouseEvent",
        ),
      ).toBe(true),
    );
    await expect(f.click(observationId, 2)).rejects.toMatchObject({
      code: "busy",
    });
    release!();
    await expect(first).resolves.toBeTruthy();
  });

  it("times out as uncertain, revokes, and never replays the action", async () => {
    const f = setup({ actionTimeoutMs: 25 });
    await f.authorize();
    const { observationId } = await f.observe();
    f.contents.debugger.behavior = {
      "Input.dispatchMouseEvent": () =>
        new Promise(() => {
          /* never settles: the action outcome is unknown */
        }),
    };
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "uncertain",
      uncertain: true,
    });
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(1);
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
    await expect(f.observe()).rejects.toMatchObject({
      code: "noAuthorization",
    });
  });

  it("uses only the fixed CDP command set for every supported action", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    await f.click(observationId, 1);
    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_type",
      { observationId, element: 2, text: "hello", submit: true },
    );
    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_scroll",
      { observationId, direction: "down" },
    );
    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_navigate",
      { url: "https://example.com/next" },
    );
    const allowed = new Set([
      "Page.enable",
      "Accessibility.enable",
      "DOM.enable",
      "Page.getLayoutMetrics",
      "Accessibility.getFullAXTree",
      "Page.captureScreenshot",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
      "DOM.focus",
      "Input.insertText",
      "Input.dispatchKeyEvent",
      "Page.navigate",
    ]);
    const methods = new Set(
      f.contents.debugger.commands.map((item) => item.method),
    );
    for (const method of methods)
      expect(allowed.has(method), `unexpected CDP command ${method}`).toBe(true);
  });

  it("asks the user before click, type and navigate but not for observe or scroll", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    expect(f.confirmAction).not.toHaveBeenCalled();

    await f.click(observationId, 1);
    expect(f.confirmAction).toHaveBeenCalledTimes(1);
    expect(f.confirmAction.mock.calls[0][0]).toMatchObject({
      page: { origin: "https://example.com" },
      action: {
        kind: "click",
        origin: "https://example.com",
        element: { role: "button", name: "Submit" },
      },
    });

    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_type",
      { observationId, element: 2, text: "Secret value", submit: false },
    );
    expect(f.confirmAction).toHaveBeenCalledTimes(2);
    const typeRequest = f.confirmAction.mock.calls[1][0] as unknown;
    expect(typeRequest).toMatchObject({
      action: {
        kind: "type",
        element: { role: "textbox", name: "Search" },
      },
    });
    // The typed text never reaches the confirmation payload.
    expect(JSON.stringify(typeRequest)).not.toContain("Secret value");

    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_scroll",
      { observationId, direction: "down" },
    );
    expect(f.confirmAction).toHaveBeenCalledTimes(2);

    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_navigate",
      { url: "https://example.com/next" },
    );
    expect(f.confirmAction).toHaveBeenCalledTimes(3);
    expect(f.confirmAction.mock.calls[2][0]).toMatchObject({
      action: {
        kind: "navigate",
        url: "https://example.com/next",
      },
    });
  });

  it("keeps the authorization but does not dispatch when the user declines", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    f.confirmAction.mockResolvedValueOnce(false);
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "confirmationDenied",
    });
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
  });

  it("revalidates the page after the user confirms", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    f.confirmAction.mockImplementationOnce(async () => {
      // The page leaves the authorized site while the dialog is open.
      f.contents.url = "https://other.example/";
      f.contents.emit(
        "did-start-navigation",
        { isMainFrame: true, isSameDocument: false },
        f.contents.url,
        false,
        true,
      );
      return true;
    });
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
  });

  it("requires a fresh observation if the page changed during the confirmation", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    f.confirmAction.mockImplementationOnce(async () => {
      // Same origin, different document: the observation is stale.
      f.contents.url = "https://example.com/other";
      return true;
    });
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "observationExpired",
    });
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
  });

  it("does not dispatch if the observed element disappeared during confirmation", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    f.contents.debugger.behavior = {
      "DOM.getBoxModel": () => {
        throw new Error("No node with given id found");
      },
    };
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "elementNotFound",
    });
    const mouse = f.contents.debugger.commands.filter(
      (item) => item.method === "Input.dispatchMouseEvent",
    );
    expect(mouse.filter((item) => item.params?.type === "mousePressed")).toHaveLength(0);
  });

  it("ignores a late confirmation and never revives the old action on a new binding", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    let answer: ((approved: boolean) => void) | null = null;
    f.confirmAction.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.click(observationId, 1);
    await vi.waitFor(() => expect(f.confirmAction).toHaveBeenCalledTimes(1));
    f.controller.revokeOwner("owner-a", "revokedByUser");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });

    // Re-authorize the same page before the stale dialog answers.
    await f.authorize();
    const current = await f.observe();
    answer!(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);

    await f.click(current.observationId, 1);
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("stops the remaining CDP steps after revocation even when re-authorized", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    let reauthorized = false;
    f.contents.debugger.behavior = {
      "Input.dispatchMouseEvent": async (params) => {
        if (params?.type === "mousePressed" && !reauthorized) {
          reauthorized = true;
          f.controller.revokePage(
            f.contents as unknown as WebContents,
            "revokedByUser",
          );
          await f.authorize();
          await f.observe();
        }
      },
    };
    await expect(f.click(observationId, 1)).rejects.toMatchObject({
      code: "uncertain",
    });
    const mouse = f.contents.debugger.commands.filter(
      (item) => item.method === "Input.dispatchMouseEvent",
    );
    expect(mouse.filter((item) => item.params?.type === "mousePressed")).toHaveLength(1);
    expect(mouse.filter((item) => item.params?.type === "mouseReleased")).toHaveLength(0);
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
  });

  it("does not open a confirmation dialog for an already-cancelled request", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.controller.call(
        "owner-a",
        "conversation-1",
        "nuwax_browser_click",
        { observationId, element: 1 },
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.confirmAction).not.toHaveBeenCalled();
  });

  it("does not abort a pending action confirmation for a subframe navigation", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    let answer: ((approved: boolean) => void) | null = null;
    f.confirmAction.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.click(observationId, 1);
    await vi.waitFor(() => expect(f.confirmAction).toHaveBeenCalledTimes(1));
    f.contents.emit(
      "did-start-navigation",
      { isMainFrame: false, isSameDocument: false },
      "https://other.example/frame",
      false,
      false,
    );
    answer!(true);
    await expect(pending).resolves.toBeTruthy();
    expect(
      f.contents.debugger.commands.filter(
        (item) =>
          item.method === "Input.dispatchMouseEvent" &&
          item.params?.type === "mousePressed",
      ),
    ).toHaveLength(1);
  });

  it("does not execute a confirmation that was pending when the page reloaded", async () => {
    const f = setup();
    await f.authorize();
    const { observationId } = await f.observe();
    let answer: ((approved: boolean) => void) | null = null;
    f.confirmAction.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.click(observationId, 1);
    await vi.waitFor(() => expect(f.confirmAction).toHaveBeenCalledTimes(1));

    // Same URL reload: authorization stays, the observed document is gone.
    f.contents.emit(
      "did-start-navigation",
      { isMainFrame: true, isSameDocument: false },
      f.contents.url,
      false,
      true,
    );
    await expect(pending).rejects.toMatchObject({
      code: "observationExpired",
    });
    answer!(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
  });

  it("does not store an observation whose capture crossed a same-origin reload", async () => {
    const f = setup();
    await f.authorize();
    f.contents.debugger.behavior = {
      "Accessibility.getFullAXTree": () => {
        f.contents.emit(
          "did-start-navigation",
          { isMainFrame: true, isSameDocument: false },
          f.contents.url,
          false,
          true,
        );
        return { nodes: [] };
      },
    };
    await expect(f.observe()).rejects.toMatchObject({
      code: "observationExpired",
    });
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });

    f.contents.debugger.behavior = null;
    const current = await f.observe();
    expect(current.observationId).toHaveLength(36);
  });

  it("does not count the user's confirmation time against the action timeout", async () => {
    const f = setup({ actionTimeoutMs: 25 });
    await f.authorize();
    const { observationId } = await f.observe();
    f.confirmAction.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return true;
    });
    await expect(f.click(observationId, 1)).resolves.toBeTruthy();
    expect(f.controller.stateFor(f.contents.id)).toMatchObject({
      controlled: true,
    });
  });

  it("does not let another session reuse an observation after re-authorization", async () => {
    const f = setup();
    await f.authorize("owner-a");
    const stale = await f.observe("owner-a");
    await f.controller.call(
      "owner-a",
      "conversation-1",
      "nuwax_browser_release_access",
      {},
    );
    await f.authorize("owner-b");
    await f.observe("owner-b");
    await expect(f.click(stale.observationId, 1, "owner-b")).rejects.toMatchObject({
      code: "observationRequired",
    });
    expect(
      f.contents.debugger.commands.filter(
        (item) => item.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);
  });

  it("releases access explicitly", async () => {
    const f = setup();
    await f.authorize();
    await expect(
      f.controller.call("owner-a", "conversation-1", "nuwax_browser_release_access", {}),
    ).resolves.toMatchObject({ structured: { released: true } });
    expect(f.controller.stateFor(f.contents.id)).toBeNull();
  });
});
