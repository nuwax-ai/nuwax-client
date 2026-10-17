import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  snapshot: vi.fn(),
  seen: vi.fn(),
  settings: vi.fn(),
  restart: vi.fn(),
  show: vi.fn(),
  provider: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mock.handlers.set(channel, handler),
  },
}));
vi.mock("../services/permissionOnboarding", () => ({
  getPermissionSnapshot: mock.snapshot,
  markPermissionOnboardingSeen: mock.seen,
  openGuidedPermissionSettings: mock.settings,
  restartForPermissions: mock.restart,
  showPermissionApp: mock.show,
  setPermissionGuideWindowProvider: mock.provider,
}));
import { registerPermissionOnboardingHandlers } from "./permissionOnboardingHandlers";
beforeEach(() => {
  vi.clearAllMocks();
  mock.handlers.clear();
  registerPermissionOnboardingHandlers({
    trusted: (event) => !!(event as any).hostMainFrame,
    getWindow: () => null,
  });
});
it.each([{}, { hostMainFrame: false }])(
  "rejects all new operations from untrusted/guest/child frames",
  async (event) => {
    for (const [channel, handler] of mock.handlers) {
      const result = await handler(event, "screen_recording");
      expect(result).toBe(channel.endsWith("snapshot") ? null : false);
    }
    for (const fn of [
      mock.snapshot,
      mock.seen,
      mock.settings,
      mock.restart,
      mock.show,
    ])
      expect(fn).not.toHaveBeenCalled();
  },
);
it("accepts only whitelisted keys and trusted host actions", async () => {
  const event = { hostMainFrame: true };
  const settings = mock.handlers.get("permissions:onboarding:settings")!;
  for (const key of [
    "__proto__",
    "constructor",
    "x-apple.systempreferences:anything",
    {},
    null,
  ])
    expect(await settings(event, key)).toBe(false);
  expect(mock.settings).not.toHaveBeenCalled();
  await settings(event, "helper_accessibility");
  expect(mock.settings).toHaveBeenCalledWith("helper_accessibility");
  await mock.handlers.get("permissions:onboarding:snapshot")!(event);
  expect(mock.snapshot).toHaveBeenCalledTimes(1);
  await mock.handlers.get("permissions:onboarding:restart")!(event);
  expect(mock.restart).toHaveBeenCalledTimes(1);
});
