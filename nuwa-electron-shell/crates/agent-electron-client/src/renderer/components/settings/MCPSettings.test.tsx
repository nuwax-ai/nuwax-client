import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  mounted: false,
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  switches: [] as any[],
  buttons: [] as any[],
  listeners: new Map<string, () => Promise<void>>(),
  getStatus: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  setEnabled: vi.fn(),
  off: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.states)) h.states[index] = initial;
    return [h.states[index], (value: unknown) => {
      h.states[index] = typeof value === "function" ? value(h.states[index]) : value;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (!h.mounted) h.effects.push(effect);
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}));

vi.mock("antd", () => {
  const Wrap = ({ children }: any) => <div>{children}</div>;
  const Item: any = ({ children, actions }: any) => <div>{children}{actions.map((action: React.ReactNode, index: number) => <span key={index}>{action}</span>)}</div>;
  Item.Meta = ({ title, description }: any) => <div>{title}{description}</div>;
  const List: any = ({ dataSource, renderItem }: any) => <div>{dataSource.map((item: unknown, index: number) => <div key={index}>{renderItem(item)}</div>)}</div>;
  List.Item = Item;
  return {
    Card: ({ title, extra, children }: any) => <div>{title}{extra}{children}</div>,
    Space: Wrap, Tag: Wrap, Tooltip: Wrap,
    Typography: { Text: Wrap },
    Badge: () => null, Segmented: () => null, Empty: () => null,
    Alert: () => null, Spin: () => null, Modal: () => null,
    List,
    Button: (props: any) => {
      h.buttons.push(props);
      return <button>{props.children}</button>;
    },
    Switch: (props: any) => {
      h.switches.push(props);
      return <input type="checkbox" checked={props.checked} disabled={props.disabled} readOnly />;
    },
    message: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
  };
});
vi.mock("@ant-design/icons", () => Object.fromEntries([
  "PlayCircleOutlined", "ReloadOutlined", "SaveOutlined", "ApiOutlined", "ExportOutlined",
  "ImportOutlined", "WarningOutlined", "CheckCircleOutlined", "EditOutlined", "DeleteOutlined", "UndoOutlined",
].map(name => [name, () => null])));
vi.mock("@uiw/react-textarea-code-editor", () => ({ default: () => null }));
vi.mock("./MCPServerEditor", () => ({ default: () => null }));
vi.mock("../../services/core/i18n", () => ({
  t: (key: string, args?: Record<string, unknown>) =>
    key === "Claw.MCP.list.enabledSummary" ? `enabled=${args?.[0]}/${args?.[1]}` : key,
}));

import MCPSettings from "./MCPSettings";

const config = {
  mcpServers: {
    cua: { command: "node", args: ["cua-stdio-relay.cjs"], enabled: true },
    other: { command: "other-server", args: [], enabled: true },
  },
};

function render() {
  h.cursor = 0;
  h.switches = [];
  h.buttons = [];
  const html = renderToStaticMarkup(<MCPSettings />);
  h.mounted = true;
  return html;
}
function mount() {
  render();
  for (const effect of h.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) h.cleanups.push(cleanup);
  }
}
async function ready() {
  await vi.waitFor(() => {
    render();
    expect(h.switches).toHaveLength(2);
  });
}
function button(label: string) {
  return h.buttons.find(props => props.children === label);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.states = []; h.cursor = 0; h.mounted = false;
  h.effects = []; h.cleanups = []; h.listeners.clear();
  h.getStatus.mockReset().mockResolvedValue({ enabled: false, running: false, mcpInjected: true });
  h.getConfig.mockResolvedValue(structuredClone(config));
  h.setConfig.mockResolvedValue({ success: true });
  h.off.mockImplementation((channel: string) => h.listeners.delete(channel));
  vi.stubGlobal("document", { body: { getAttribute: () => "light" } });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    electronAPI: {
      mcp: { getConfig: h.getConfig, setConfig: h.setConfig, status: async () => ({ running: true }) },
      computerUse: { getStatus: h.getStatus, setEnabled: h.setEnabled },
      on: (channel: string, callback: () => Promise<void>) => h.listeners.set(channel, callback),
      off: h.off,
    },
  }));
});
afterEach(() => {
  h.cleanups.forEach(cleanup => cleanup());
  vi.unstubAllGlobals();
});

describe("MCP Computer Use status display", () => {
  it("shows Computer Use off and excludes it from the enabled count while retaining its saved MCP entry", async () => {
    mount(); await ready();
    expect(h.switches[0]).toMatchObject({ checked: false, disabled: true, loading: false });
    expect(h.switches[1].checked).toBe(true);
    expect(render()).toContain("enabled=1/2");
    expect(h.setConfig).not.toHaveBeenCalled();
    await button("Claw.Common.save").onClick();
    expect(h.setConfig).toHaveBeenCalledWith(config);
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("follows live switch changes without overwriting an unsaved MCP draft or changing Agent configuration", async () => {
    mount(); await ready();
    h.switches[1].onChange(false);
    render();
    h.getStatus.mockResolvedValue({ enabled: true, running: false, mcpInjected: true });
    await h.listeners.get("cua:runtime")!();
    expect(render()).toContain("enabled=1/2");
    expect(h.switches[0]).toMatchObject({ checked: true, disabled: true });
    expect(h.switches[1].checked).toBe(false);
    h.getStatus.mockResolvedValue({ enabled: false, running: false, mcpInjected: true });
    await h.listeners.get("cua:runtime")!();
    expect(render()).toContain("enabled=0/2");
    expect(h.setConfig).not.toHaveBeenCalled();
    await button("Claw.Common.save").onClick();
    expect(h.setConfig).toHaveBeenCalledWith({ mcpServers: {
      cua: config.mcpServers.cua,
      other: { ...config.mcpServers.other, enabled: false },
    } });
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("ignores a stale status response and removes the runtime listener on unmount", async () => {
    let resolveOld!: (status: { enabled: boolean }) => void;
    h.getStatus.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    mount(); await ready();
    expect(h.switches[0].loading).toBe(true);
    h.getStatus.mockResolvedValue({ enabled: true });
    const refresh = h.listeners.get("cua:runtime")!;
    await refresh();
    resolveOld({ enabled: false });
    await Promise.resolve();
    render();
    expect(h.switches[0]).toMatchObject({ checked: true, loading: false });
    h.cleanups.splice(0).forEach(cleanup => cleanup());
    expect(h.off).toHaveBeenCalledWith("cua:runtime", refresh);
    expect(h.listeners.has("cua:runtime")).toBe(false);
  });

  it("keeps an unreadable switch in loading state and refreshes it on window focus", async () => {
    h.getStatus.mockRejectedValueOnce(new Error("status unavailable"));
    mount(); await ready();
    expect(h.switches[0]).toMatchObject({ disabled: true, loading: true });
    h.getStatus.mockResolvedValue({ enabled: true });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => {
      render();
      expect(h.switches[0]).toMatchObject({ checked: true, loading: false });
    });
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.setEnabled).not.toHaveBeenCalled();
  });
});
