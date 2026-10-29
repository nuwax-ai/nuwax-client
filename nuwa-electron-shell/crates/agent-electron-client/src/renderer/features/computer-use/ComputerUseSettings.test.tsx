import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  states: [] as any[],
  cursor: 0,
  effects: [] as any[],
  switches: [] as any[],
  buttons: [] as any[],
  confirm: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => {
    const index = harness.cursor++;
    return [
      harness.states[index],
      (value: any) => {
        harness.states[index] = typeof value === "function" ? value(harness.states[index]) : value;
      },
    ];
  },
  useEffect: (effect: any) => harness.effects.push(effect),
  useCallback: (fn: any) => fn,
  useRef: (init: any) => ({ current: init }),
}));

vi.mock("antd", async () => {
  const Input: any = (props: any) => <input {...props} />;
  Input.Password = (props: any) => <input type="password" {...props} />;
  return {
    Button: (props: any) => {
      harness.buttons.push(props);
      return <button disabled={props.disabled}>{props.children}</button>;
    },
    Input,
    Modal: { confirm: harness.confirm },
    Select: ({ options, placeholder }: any) => (
      <span>{placeholder} {(options ?? []).map((option: any) => option.label).join(" ")}</span>
    ),
    Space: ({ children }: any) => <span>{children}</span>,
    Switch: (props: any) => {
      harness.switches.push(props);
      return <input type="checkbox" checked={!!props.checked} readOnly />;
    },
    message: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

vi.mock("./CuaControls", () => ({ CuaSettingsRows: () => <div>recovery-rows</div> }));
vi.mock("./visibleSnapshot", () => ({ watchCuaVisibleSnapshot: () => () => undefined }));

import { ComputerUseSettings } from "./ComputerUseSettings";

const installedOff = {
  supported: true,
  installed: true,
  installable: true,
  running: false,
  enabled: false,
  consentPending: false,
  agentCursor: true,
  authMode: "ask" as const,
  blacklist: [] as string[],
  screenshotHome: "~/.nuwax/computer-use",
  accessibility: false,
  screenRecording: false,
  error: null,
};

const Row = ({ label, desc, control }: any) => (
  <section>
    <h4>{label}</h4>
    <p>{desc}</p>
    {control}
  </section>
);

const api = {
  setEnabled: vi.fn(),
  setAgentCursor: vi.fn(),
  setAuthMode: vi.fn(),
  setBlacklist: vi.fn(),
};

function seed(status = installedOff, pending = false) {
  harness.states = [
    status,
    pending,
    false,
    false,
    false,
    { baseUrl: "", model: "", apiKey: "", hasApiKey: false },
    false,
    [],
    [],
  ];
}

beforeEach(() => {
  vi.resetAllMocks();
  harness.cursor = 0;
  harness.effects = [];
  harness.switches = [];
  harness.buttons = [];
  seed();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    electronAPI: { on: vi.fn(), off: vi.fn(), permissionOnboarding: { openSettings: vi.fn() } },
  }));
});

afterEach(() => vi.unstubAllGlobals());

const render = () => {
  harness.cursor = 0;
  harness.switches = [];
  harness.buttons = [];
  return renderToStaticMarkup(
    <ComputerUseSettings t={(key) => key} Row={Row} api={api as any} />,
  );
};

describe("ComputerUseSettings", () => {
  it("keeps enable, permissions and next action in one setup cluster", () => {
    const html = render();
    expect(html).toContain('data-cluster="setup"');
    expect(html).toContain('data-cluster="behavior"');
    expect(html).toContain('data-cluster="privacy"');
    expect(html).toContain("Claw.Settings.computerUse.setupSection");
    expect(html).toContain("Claw.Settings.computerUse.nextEnable");
    expect(html).toContain("Claw.Settings.computerUse.permissions");
    expect(html).not.toContain("Claw.Settings.computerUse.pendingTitle");
  });

  it("asks for the short Nuwax Computer Use consent before enabling", async () => {
    render();
    const pending = harness.switches[0].onChange(true);
    expect(harness.confirm).toHaveBeenCalledOnce();
    const dialog = harness.confirm.mock.calls[0][0];
    expect(dialog.title).toBe("Claw.Settings.computerUse.consentTitle");
    expect(dialog.okText).toBe("Claw.Settings.computerUse.consentAccept");
    expect(dialog.cancelText).toBe("Claw.Settings.computerUse.consentCancel");
    expect(renderToStaticMarkup(dialog.content)).toContain("Claw.Settings.computerUse.consentDescription");
    expect(api.setEnabled).not.toHaveBeenCalled();
    dialog.onCancel();
    await pending;
  });

  it("folds cancel-enable into the switch row instead of a second pending block", () => {
    seed({ ...installedOff, consentPending: true }, true);
    const html = render();
    expect(html).toContain("Claw.Settings.computerUse.cancelPreparation");
    expect(html).toContain("Claw.Settings.computerUse.nextGrant");
    expect(html).toContain("Claw.Settings.computerUse.pendingDescription");
    expect(html).not.toContain("Claw.Settings.computerUse.pendingTitle");
    expect(html).toContain("Claw.Settings.computerUse.continueEnable");
  });

  it("keeps behavior and privacy controls after grouping", () => {
    seed({
      ...installedOff,
      enabled: true,
      running: true,
      accessibility: true,
      screenRecording: true,
    });
    const html = render();
    expect(html).toContain("Claw.Settings.computerUse.agentCursor");
    expect(html).toContain("Claw.Settings.computerUse.authMode");
    expect(html).toContain("Claw.Settings.computerUse.blacklist");
    expect(html).toContain("Claw.Settings.computerUse.privacy");
    expect(html).toContain("Claw.Settings.computerUse.lockBehavior");
    expect(html).toContain("Claw.Settings.computerUse.taskModelDescription");
    expect(html).toContain("Claw.Settings.computerUse.advancedDiagnostics");
    expect(html).toContain("Claw.Settings.computerUse.nextReady");
    expect(html).not.toContain("Claw.Settings.computerUse.scope");
    expect(html).not.toContain("Claw.Settings.computerUse.diagnostics");
  });

  it("hides macOS helper permission controls on Windows", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const html = render();
    expect(html).not.toContain("Claw.Settings.computerUse.permissions");
    expect(html).toContain("Claw.Settings.computerUse.setupSection");
  });
});
