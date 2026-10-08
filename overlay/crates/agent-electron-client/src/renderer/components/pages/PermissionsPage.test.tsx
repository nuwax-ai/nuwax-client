import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{ current: any }>, cursor: 0, refCursor: 0,
  effects: [] as Array<() => (() => void)>, setters: [] as unknown[],
  buttons: [] as Array<{ children: string; onClick: () => Promise<void> }>,
  check: vi.fn(), openSettings: vi.fn(), error: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => {
    const index = harness.cursor++;
    return [harness.state[index], (value: unknown) => { harness.state[index] = value; harness.setters.push(value); }];
  },
  useRef: (initial: unknown) => {
    const index = harness.refCursor++;
    return harness.refs[index] ??= { current: initial };
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void)) => { harness.effects.push(effect); },
}));
vi.mock("antd", async () => {
  const { default: React } = await import("react");
  const Container = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  return { Tag: Container, Spin: Container, message: { error: harness.error },
    Button: (props: { children: string; onClick: () => Promise<void> }) => {
      harness.buttons.push(props);
      return <button>{props.children}</button>;
    },
  };
});
vi.mock("@ant-design/icons", async () => {
  const { default: React } = await import("react");
  const Icon = () => <span />;
  return { CheckCircleOutlined: Icon, CloseCircleOutlined: Icon, QuestionCircleOutlined: Icon, ReloadOutlined: Icon, SettingOutlined: Icon };
});
vi.mock("../../services/core/i18n", () => ({ t: (key: string) => key }));
import PermissionsPage from "./PermissionsPage";

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  harness.state = [[{ key: "notifications", name: "消息通知", description: "系统通知授权", status: "denied" }], false];
  harness.refs = []; harness.cursor = 0; harness.refCursor = 0; harness.effects = []; harness.setters = []; harness.buttons = [];
  const target = new EventTarget();
  vi.stubGlobal("window", Object.assign(target, { electronAPI: { permissions: { check: harness.check, openSettings: harness.openSettings } } }));
  harness.check.mockResolvedValue(harness.state[0]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("notification permission row", () => {
  it.each([["granted", "notificationsEnabled"], ["denied", "notificationsDisabled"], ["unknown", "unknown"]])(
    "renders the correct label for %s", (status, key) => {
      (harness.state[0] as any[])[0].status = status;
      expect(renderToStaticMarkup(<PermissionsPage />)).toContain(`Claw.PermissionsPage.${key}`);
    },
  );
  it("shows a settings failure instead of starting a poll", async () => {
    renderToStaticMarkup(<PermissionsPage />);
    harness.openSettings.mockResolvedValue({ success: false });
    await harness.buttons.find((button) => button.children === "Claw.PermissionsPage.openSettings")!.onClick();
    expect(harness.error).toHaveBeenCalledWith("Claw.PermissionsPage.cannotOpenSettings");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes on return and cleans up focus listeners and settings polling", async () => {
    renderToStaticMarkup(<PermissionsPage />);
    const cleanup = harness.effects[0]();
    await Promise.resolve();
    harness.openSettings.mockResolvedValue({ success: true });
    await harness.buttons.find((button) => button.children === "Claw.PermissionsPage.openSettings")!.onClick();
    expect(vi.getTimerCount()).toBe(2);
    window.dispatchEvent(new Event("focus"));
    expect(harness.check).toHaveBeenCalledTimes(2);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("focus"));
    expect(harness.check).toHaveBeenCalledTimes(2);
  });
  it("ignores an older response after a return check has completed", async () => {
    let resolveOld!: (value: unknown) => void;
    harness.check.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    renderToStaticMarkup(<PermissionsPage />);
    const cleanup = harness.effects[0]();
    const fresh = [{ key: "notifications", status: "granted" }];
    harness.check.mockResolvedValueOnce(fresh);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(harness.state[0]).toBe(fresh);
    resolveOld([{ key: "notifications", status: "denied" }]);
    await Promise.resolve();
    expect(harness.state[0]).toBe(fresh);
    cleanup();
  });
});
