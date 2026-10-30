import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  cursor: 0,
  pending: [] as Array<() => void>,
  dirty: true,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = hooks.cursor++;
      if (!hooks.slots[index])
        hooks.slots[index] = {
          value: typeof initial === "function" ? initial() : initial,
        };
      const slot = hooks.slots[index];
      return [
        slot.value,
        (next: any) => {
          const value = typeof next === "function" ? next(slot.value) : next;
          if (value !== slot.value) {
            slot.value = value;
            hooks.dirty = true;
          }
        },
      ];
    },
    useRef(initial: unknown) {
      const index = hooks.cursor++;
      return (hooks.slots[index] ||= { current: initial });
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = hooks.cursor++;
      const previous = hooks.slots[index];
      if (
        !previous ||
        !deps ||
        deps.some((value, i) => value !== previous.deps[i])
      ) {
        hooks.slots[index] = { deps, cleanup: previous?.cleanup };
        hooks.pending.push(() => {
          previous?.cleanup?.();
          hooks.slots[index].cleanup = effect();
        });
      }
    },
    useImperativeHandle(ref: any, create: () => unknown) {
      ++hooks.cursor;
      ref.current = create();
    },
  };
});
vi.mock("../../services/core/auth", () => ({
  normalizeServerHost: (host: string) => host,
}));
vi.mock("../../services/utils/sessionUrl", () => ({
  buildHomeUrl: (host: string) => `${host}/home`,
}));
vi.mock("../../services/utils/logService", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/core/i18n", () => ({ getCurrentLang: () => "zh-CN" }));
vi.mock("../GuestPageViewport", () => ({
  GuestPageViewport: (props: any) => props.children,
}));
import Host, {
  GUEST_SLOW_HINT_MS,
  type NuwaxHostWebviewHandle,
} from "./NuwaxHostWebview";
import { PageLoadRecovery } from "../PageLoadRecovery";
function find(node: any, type: any): any {
  if (!node || typeof node !== "object") return null;
  if (node.type === type) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const match = find(child, type);
    if (match) return match;
  }
  return null;
}
function createGuest() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    addEventListener: vi.fn((name, listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    }),
    removeEventListener: vi.fn((name, listener) =>
      listeners.get(name)?.delete(listener),
    ),
    reload: vi.fn(),
    getURL: () => "https://test.example/home",
    canGoBack: () => false,
    canGoForward: () => false,
    emit(name: string, event = {}) {
      for (const listener of listeners.get(name) || []) listener(event);
    },
    capture(name: string) {
      return [...(listeners.get(name) || [])];
    },
  };
}
let events: Map<string, (payload?: unknown) => void>;
let settings: ReturnType<typeof vi.fn>;
let tree: any;
let guest: ReturnType<typeof createGuest>;
let guestKey: string | null;
let guestRef: any;
let handle: { current: NuwaxHostWebviewHandle | null };
let phases: ReturnType<typeof vi.fn>;
async function paint() {
  for (let pass = 0; pass < 20; ++pass) {
    if (hooks.dirty) {
      hooks.dirty = false;
      hooks.cursor = 0;
      tree = (Host as any).render(
        { onGuestLoadStateChange: phases, onOpenSettings: vi.fn() },
        handle,
      );
      const node = find(tree, "webview");
      if (node) {
        if (guestKey !== node.key) {
          guest = createGuest();
          guestKey = node.key;
        }
        guestRef = (node as any).ref;
        guestRef.current = guest;
      } else if (guestRef) guestRef.current = null;
      for (const effect of hooks.pending.splice(0)) effect();
    }
    for (let i = 0; i < 8; ++i) await Promise.resolve();
    if (!hooks.dirty) break;
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.pending = [];
  hooks.dirty = true;
  guestKey = null;
  guestRef = null;
  events = new Map();
  handle = { current: null };
  phases = vi.fn();
  settings = vi.fn(async (key) =>
    key === "step1_config" ? { serverHost: "https://test.example" } : null,
  );
  vi.stubGlobal("navigator", { userAgent: "test" });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electronAPI: {
      app: { getVersion: async () => "3.0.23" },
      settings: { get: settings },
      on: (name: string, listener: any) => events.set(name, listener),
      off: vi.fn(),
    },
  });
});
afterEach(() => {
  for (const slot of hooks.slots) slot?.cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("guest recovery lifecycle", () => {
  it("leaves routine refresh loading to the guest without a second shell card", async () => {
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("loading");
    guest.emit("did-stop-loading");
    await paint();
    expect(find(tree, PageLoadRecovery)).toBeNull();

    const live = guest;
    handle.current!.reload();
    handle.current!.reload();
    await paint();
    expect(guest.reload).toHaveBeenCalledTimes(1);
    expect(find(tree, PageLoadRecovery)).toBeNull();
    guest.emit("did-start-navigation", {
      isMainFrame: true,
      url: "https://test.example/home",
    });
    guest.emit("did-start-loading");
    await paint();
    expect(find(tree, PageLoadRecovery)).toBeNull();
    guest.emit("did-stop-loading");
    await paint();
    expect(find(tree, PageLoadRecovery)).toBeNull();
    expect(guest).toBe(live);

    handle.current!.reload();
    await paint();
    expect(guest.reload).toHaveBeenCalledTimes(2);
    expect(find(tree, PageLoadRecovery)).toBeNull();
  });
  it("still offers shell recovery when a routine refresh is slow or fails", async () => {
    await paint();
    guest.emit("did-stop-loading");
    await paint();
    handle.current!.reload();
    await paint();
    vi.advanceTimersByTime(GUEST_SLOW_HINT_MS);
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("waiting");
    expect(phases).toHaveBeenLastCalledWith("waiting");
    guest.emit("did-fail-load", {
      isMainFrame: true,
      errorCode: -105,
      validatedURL: "https://test.example/home",
    });
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("failed");
    expect(phases).toHaveBeenLastCalledWith("failed");

    const failedGuest = guest;
    find(tree, PageLoadRecovery).props.onReload();
    await paint();
    expect(guest).not.toBe(failedGuest);
    expect(find(tree, PageLoadRecovery).props.mode).toBe("reloading");
    guest.emit("did-stop-loading");
    await paint();
    expect(find(tree, PageLoadRecovery)).toBeNull();
  });
  it("uncovers main failures immediately and ignores subframes/aborted navigation", async () => {
    await paint();
    guest.emit("did-fail-load", { isMainFrame: false, errorCode: -105 });
    guest.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
    await paint();
    expect(find(tree, PageLoadRecovery)?.props.mode).not.toBe("failed");
    guest.emit("did-fail-load", {
      isMainFrame: true,
      errorCode: -105,
      validatedURL: "https://test.example/home",
    });
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("failed");
    expect(phases).toHaveBeenLastCalledWith("failed");
    guest.emit("did-stop-loading");
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("failed");
  });
  it("keeps a slow guest mounted and lets the original document finish naturally", async () => {
    await paint();
    const live = guest;
    const key = guestKey;
    vi.advanceTimersByTime(GUEST_SLOW_HINT_MS);
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("waiting");
    expect(guest).toBe(live);
    expect(guestKey).toBe(key);
    expect(guest.reload).not.toHaveBeenCalled();
    guest.emit("did-stop-loading");
    await paint();
    expect(find(tree, PageLoadRecovery)?.props.mode).not.toBe("failed");
    expect(guest).toBe(live);
  });
  it("uses one refresh entry for card and toolbar and unlocks after a synchronous rejection", async () => {
    await paint();
    vi.advanceTimersByTime(GUEST_SLOW_HINT_MS);
    await paint();
    find(tree, PageLoadRecovery).props.onReload();
    handle.current!.reload();
    expect(guest.reload).toHaveBeenCalledTimes(1);
    guest.emit("did-stop-loading");
    await paint();
    guest.reload.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    handle.current!.reload();
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("failed");
    const failedGuest = guest;
    find(tree, PageLoadRecovery).props.onReload();
    handle.current!.reload();
    await paint();
    expect(guest).not.toBe(failedGuest);
    expect(
      settings.mock.calls.filter(([key]) => key === "step1_config"),
    ).toHaveLength(2);
  });
  it("ignores callbacks from a replaced guest and a superseded main navigation", async () => {
    await paint();
    const oldFailure = guest.capture("did-fail-load")[0];
    events.get("nuwax:serverHostChanged")!();
    oldFailure({ isMainFrame: true, errorCode: -105 });
    await paint();
    expect(find(tree, PageLoadRecovery)?.props.mode).not.toBe("failed");
    oldFailure({ isMainFrame: true, errorCode: -105 });
    await paint();
    expect(find(tree, PageLoadRecovery)?.props.mode).not.toBe("failed");
    guest.emit("did-start-navigation", {
      isMainFrame: true,
      url: "https://test.example/new",
    });
    guest.emit("did-fail-load", {
      isMainFrame: true,
      errorCode: -105,
      validatedURL: "https://test.example/home",
    });
    await paint();
    expect(find(tree, PageLoadRecovery)?.props.mode).not.toBe("failed");
  });
  it("offers resolve recovery and ignores its old rejected work after switching domains", async () => {
    let reject!: (reason: Error) => void;
    settings.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    await paint();
    vi.advanceTimersByTime(GUEST_SLOW_HINT_MS);
    await paint();
    expect(find(tree, PageLoadRecovery).props.stage).toBe("resolve");
    events.get("nuwax:serverHostChanged")!();
    await paint();
    reject(new Error("old domain"));
    await paint();
    expect(find(tree, PageLoadRecovery)?.props.mode).not.toBe("failed");
    settings.mockRejectedValueOnce(new Error("IPC unavailable"));
    events.get("nuwax:serverHostChanged")!();
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("failed");
    expect(phases).toHaveBeenLastCalledWith("failed");
  });
  it("rebuilds a crashed guest once and consumes rejected reload promises", async () => {
    await paint();
    guest.emit("did-stop-loading");
    await paint();
    guest.reload.mockReturnValueOnce(
      Promise.reject(new Error("reload not available")),
    );
    handle.current!.reload();
    await paint();
    expect(find(tree, PageLoadRecovery).props.mode).toBe("failed");
    handle.current!.reload();
    await paint();
    guest.emit("render-process-gone", {
      details: { reason: "private native details" },
    });
    await paint();
    expect(find(tree, PageLoadRecovery).props.stage).toBe("crash");
    const crashed = guest;
    const oldCallback = guest.capture("render-process-gone")[0];
    find(tree, PageLoadRecovery).props.onReload();
    handle.current!.reload();
    await paint();
    expect(guest).not.toBe(crashed);
    expect(
      settings.mock.calls.filter(([key]) => key === "step1_config"),
    ).toHaveLength(3);
    oldCallback({});
    await paint();
    expect(find(tree, PageLoadRecovery)?.props.mode).not.toBe("failed");
  });
});
