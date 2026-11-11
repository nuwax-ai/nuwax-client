import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserState } from "@shared/features/browser/contract";
vi.mock("./tabStrip", () => ({ createTabStrip: () => vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(
  initial: Promise<BrowserState | null> = Promise.resolve(null),
) {
  vi.resetModules();
  const elements = new Map<
    string,
    {
      value: string;
      hidden: boolean;
      disabled: boolean;
      textContent: string;
      focus: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      setAttribute: ReturnType<typeof vi.fn>;
      toggleAttribute: ReturnType<typeof vi.fn>;
      getBoundingClientRect: () => { x: number };
      addEventListener: (
        type: string,
        handler: (event: unknown) => void,
      ) => void;
      events: Map<string, (event: unknown) => void>;
    }
  >();
  const html = readFileSync(
    new URL("../../browser.html", import.meta.url),
    "utf8",
  );
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    const events = new Map<string, (event: unknown) => void>();
    elements.set(id, {
      value: "",
      hidden: false,
      disabled: false,
      textContent: "",
      focus: vi.fn(),
      select: vi.fn(),
      setAttribute: vi.fn(),
      toggleAttribute: vi.fn(),
      getBoundingClientRect: () => ({ x: 88 }),
      events,
      addEventListener: (name, fn) => events.set(name, fn),
    });
  }
  const command = vi.fn(async () => true);
  let renderState: (state: BrowserState) => void = () => {};
  vi.stubGlobal("document", {
    documentElement: { style: { setProperty: vi.fn() } },
    body: { classList: { toggle: vi.fn() }, dataset: {} },
    getElementById: (id: string) => elements.get(id),
  });
  vi.stubGlobal("window", {
    browserWindow: {
      command,
      getState: () => initial,
      onState: (listener: (state: BrowserState) => void) => {
        renderState = listener;
        return vi.fn();
      },
    },
    addEventListener: vi.fn(),
  });
  await import("./toolbar");
  const state = {
    title: "Document",
    tabs: [{ id: 12, title: "Document", loading: false }],
    activeTabId: 12,
    url: "https://business.example/doc",
    domain: "business.example",
    platform: "darwin",
    canGoBack: false,
    canGoForward: false,
    finding: false,
    findText: "",
    findFocusRequest: 0,
    matches: 0,
    activeMatch: 0,
    copyFeedback: null,
    labels: {
      copyDone: "链接已复制",
      copyFailed: "复制失败，请重试",
    },
  } as BrowserState;
  return {
    elements,
    command,
    state,
    update: (next: Partial<BrowserState>) => renderState({ ...state, ...next }),
  };
}

describe("browser toolbar find state", () => {
  it("clears the previous query after close and reopens with the reset match count", async () => {
    const f = await setup();
    f.update({ finding: true, matches: 2, activeMatch: 1 });
    const query = f.elements.get("query")!;
    query.value = "previous term";
    f.update({ finding: false });
    expect(query.value).toBe("");
    expect(f.elements.get("findbar")!.hidden).toBe(true);
    f.update({ finding: true, findFocusRequest: 1 });
    expect(f.elements.get("matches")!.textContent).toBe("0/0");
    expect(query.value).toBe("");
    expect(query.focus).toHaveBeenCalledTimes(2);
  });
  it("keeps the current draft and focus during ordinary match updates", async () => {
    const f = await setup();
    f.update({ finding: true });
    const query = f.elements.get("query")!;
    query.value = "current term";
    f.update({ finding: true, matches: 5, activeMatch: 3 });
    expect(query.value).toBe("current term");
    expect(query.focus).toHaveBeenCalledOnce();
    query.events.get("keydown")!({
      key: "Enter",
      preventDefault: vi.fn(),
      shiftKey: true,
    });
    expect(f.command).toHaveBeenCalledWith({
      type: "find",
      text: "current term",
      forward: false,
      next: true,
    });
  });
  it("ignores a delayed initial snapshot after a live state update", async () => {
    let resolveInitial!: (state: BrowserState) => void;
    const f = await setup(
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    );
    f.update({ finding: true, title: "Current document" });
    f.elements.get("query")!.value = "new term";
    resolveInitial({ ...f.state, title: "Old document", finding: false });
    await Promise.resolve();
    expect(f.elements.get("title")!.textContent).toBe("Current document");
    expect(f.elements.get("findbar")!.hidden).toBe(false);
    expect(f.elements.get("query")!.value).toBe("new term");
  });
});

describe("browser toolbar actions and feedback", () => {
  it("shows navigation only when the current page can go back or forward", async () => {
    const f = await setup();
    for (const [canGoBack, canGoForward] of [
      [false, false],
      [true, false],
      [true, true],
      [false, true],
      [false, false],
    ]) {
      f.update({ canGoBack, canGoForward });
      expect(f.elements.get("navigation")!.hidden).toBe(!canGoBack && !canGoForward);
      expect(f.elements.get("back")!.disabled).toBe(!canGoBack);
      expect(f.elements.get("forward")!.disabled).toBe(!canGoForward);
    }
    f.update({ canGoBack: true, canGoForward: true });
    f.elements.get("back")!.events.get("click")!({});
    expect(f.command).toHaveBeenLastCalledWith({ type: "back" });
    f.elements.get("forward")!.events.get("click")!({});
    expect(f.command).toHaveBeenLastCalledWith({ type: "forward" });
  });

  it("shows a success toast only for a successful copy result, then dismisses it", async () => {
    const f = await setup();
    vi.useFakeTimers();
    f.update({ copyFeedback: { id: 1, success: true } });
    expect(f.elements.get("feedbackText")!.textContent).toBe("链接已复制");
    expect(f.elements.get("feedback")!.hidden).toBe(false);
    expect(f.elements.get("feedbackSuccess")!.hidden).toBe(false);
    vi.advanceTimersByTime(2200);
    expect(f.elements.get("feedback")!.hidden).toBe(true);
    // Navigation/loading updates must not replay an expired toast.
    f.update({ loading: true, copyFeedback: { id: 1, success: true } });
    expect(f.elements.get("feedback")!.hidden).toBe(true);
  });

  it("refreshes the toast duration on repeated copies and reports a failed copy", async () => {
    const f = await setup();
    vi.useFakeTimers();
    f.update({ copyFeedback: { id: 1, success: true } });
    vi.advanceTimersByTime(1800);
    f.update({ copyFeedback: { id: 2, success: false } });
    vi.advanceTimersByTime(400);
    expect(f.elements.get("feedback")!.hidden).toBe(false);
    expect(f.elements.get("feedbackText")!.textContent).toBe("复制失败，请重试");
    expect(f.elements.get("feedbackSuccess")!.hidden).toBe(true);
    vi.advanceTimersByTime(1800);
    expect(f.elements.get("feedback")!.hidden).toBe(true);
  });

  it("routes direct actions and anchors the menu beneath the title capsule", async () => {
    const f = await setup();
    for (const [id, command] of [
      ["copyLink", { type: "copy" }],
      ["copy", { type: "copy" }],
      ["search", { type: "find-open" }],
      ["menu", { type: "menu", x: 88 }],
    ] as const) {
      f.elements.get(id)!.events.get("click")!({});
      expect(f.command).toHaveBeenLastCalledWith(command);
    }
  });
});
