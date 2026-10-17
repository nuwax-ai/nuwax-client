import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  ref: { current: false },
  snapshot: vi.fn(),
  seen: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  open: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void) => h.effects.push(effect),
  useRef: () => h.ref,
}));
import PermissionOnboardingEntry from "./PermissionOnboardingEntry";
beforeEach(() => {
  vi.resetAllMocks();
  h.ref.current = false;
  h.effects = [];
  vi.stubGlobal("window", {
    electronAPI: {
      permissionOnboarding: { snapshot: h.snapshot, markSeen: h.seen },
      on: h.on,
      off: h.off,
    },
  });
  h.seen.mockResolvedValue(true);
});
it("displays the first overview and persists seen independently of grants", async () => {
  h.snapshot.mockResolvedValue({ seen: false, items: [{ status: "denied" }] });
  PermissionOnboardingEntry({ ready: true, onOpen: h.open });
  h.effects.forEach((effect) => effect());
  await Promise.resolve();
  expect(h.open).toHaveBeenCalledWith("overview");
  expect(h.seen).toHaveBeenCalledTimes(1);
});
it("respects skip/completion and waits for startup readiness", async () => {
  PermissionOnboardingEntry({ ready: false, onOpen: h.open });
  h.effects.forEach((effect) => effect());
  expect(h.snapshot).not.toHaveBeenCalled();
  h.effects = [];
  h.snapshot.mockResolvedValue({ seen: true });
  PermissionOnboardingEntry({ ready: true, onOpen: h.open });
  h.effects.forEach((effect) => effect());
  await Promise.resolve();
  expect(h.open).not.toHaveBeenCalled();
});
it("keeps a feature-targeted step instead of overwriting it with a late overview", async () => {
  let resolve!: (value: unknown) => void;
  h.snapshot.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  PermissionOnboardingEntry({ ready: true, onOpen: h.open });
  const cleanups = h.effects.map((effect) => effect());
  const navigate = h.on.mock.calls[0][1];
  navigate("__proto__");
  expect(h.open).not.toHaveBeenCalled();
  navigate("helper_accessibility");
  resolve({ seen: false });
  await Promise.resolve();
  expect(h.open.mock.calls).toEqual([["helper_accessibility"]]);
  cleanups.forEach((cleanup) => cleanup?.());
  expect(h.off).toHaveBeenCalledWith("permissions:guide", navigate);
});
it("ignores a startup response after unmount", async () => {
  let resolve!: (value: unknown) => void;
  h.snapshot.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  PermissionOnboardingEntry({ ready: true, onOpen: h.open });
  h.effects.map((effect) => effect()).forEach((cleanup) => cleanup?.());
  resolve({ seen: false });
  await Promise.resolve();
  expect(h.open).not.toHaveBeenCalled();
});
