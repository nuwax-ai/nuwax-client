import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserState } from "@shared/features/browser/contract";

vi.mock("./toolbar.css", () => ({}));
afterEach(() => vi.unstubAllGlobals());

async function setup(
  initial: Promise<BrowserState | null> = Promise.resolve(null),
) {
  vi.resetModules();
  const elements = new Map<
    string,
    {
      value: string;
      hidden: boolean;
      textContent: string;
      focus: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      setAttribute: ReturnType<typeof vi.fn>;
      toggleAttribute: ReturnType<typeof vi.fn>;
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
      textContent: "",
      focus: vi.fn(),
      select: vi.fn(),
      setAttribute: vi.fn(),
      toggleAttribute: vi.fn(),
      events,
      addEventListener: (name, fn) => events.set(name, fn),
    });
  }
  const command = vi.fn(async () => true);
  const unsubscribe = vi.fn();
  const theme = { apply: vi.fn(() => true), dispose: vi.fn() };
  const events = new Map<string, () => void>();
  let renderState: (state: BrowserState) => void = () => {};
  const document = {
    title: "",
    documentElement: { style: { setProperty: vi.fn() } },
    body: { classList: { toggle: vi.fn() }, dataset: {} },
    getElementById: (id: string) => elements.get(id),
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    browserWindow: {
      command,
      getState: () => initial,
      onState: (listener: (state: BrowserState) => void) => {
        renderState = listener;
        return unsubscribe;
      },
    },
    addEventListener: (name: string, listener: () => void) => events.set(name, listener),
  });
  const { startBrowserToolbar } = await import("./toolbar");
  await startBrowserToolbar(() => theme);
  const state = {
    title: "Document",
    url: "https://business.example/doc",
    domain: "business.example",
    platform: "darwin",
    finding: false,
    findFocusRequest: 0,
    matches: 0,
    activeMatch: 0,
    labels: {},
  } as BrowserState;
  return {
    elements,
    command,
    document,
    theme,
    unsubscribe,
    unload: () => events.get("unload")!(),
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

it("applies toolbar theme snapshots and releases the listener and theme on close", async () => {
  const f = await setup();
  const snapshot = { revision: 2, mode: "dark" } as BrowserState["themeSnapshot"];
  f.update({ title: "Current document", themeSnapshot: snapshot });
  expect(f.theme.apply).toHaveBeenCalledOnce();
  expect(f.theme.apply).toHaveBeenCalledWith(snapshot);
  expect(f.document.title).toBe("Current document");
  expect(f.document.body.dataset).toMatchObject({ theme: "dark" });
  for (const [id, part] of [["toolbar", "browser-toolbar"], ["address", "browser-address"], ["findbar", "browser-find"]]) {
    expect(f.elements.get(id)!.setAttribute).toHaveBeenCalledWith("data-theme-part", part);
  }
  f.unload();
  f.update({ themeSnapshot: { revision: 3, mode: "dark" } as BrowserState["themeSnapshot"] });
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.theme.dispose).toHaveBeenCalledOnce();
  expect(f.theme.apply).toHaveBeenCalledOnce();
});
