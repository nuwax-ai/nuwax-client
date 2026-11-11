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
  getStatus: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  setEnabled: vi.fn(),
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
    Badge: () => null, Segmented: () => null,
    Empty: ({ description }: any) => <div>{description}</div>,
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
    expect(render()).toContain("enabled=");
  });
}
function button(label: string) {
  return h.buttons.find(props => props.children === label);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.states = []; h.cursor = 0; h.mounted = false;
  h.effects = []; h.cleanups = [];
  h.getStatus.mockReset().mockResolvedValue({ enabled: false, running: false, mcpInjected: true });
  h.getConfig.mockResolvedValue(structuredClone(config));
  h.setConfig.mockResolvedValue({ success: true });
  vi.stubGlobal("document", { body: { getAttribute: () => "light" } });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    electronAPI: {
      mcp: { getConfig: h.getConfig, setConfig: h.setConfig, status: async () => ({ running: true }) },
      computerUse: { getStatus: h.getStatus, setEnabled: h.setEnabled },
    },
  }));
});
afterEach(() => {
  h.cleanups.forEach(cleanup => cleanup());
  vi.unstubAllGlobals();
});

describe("MCP managed entry visibility", () => {
  it.each([true, false])("hides cua from the list and count with Computer Use enabled=%s, retaining the saved entry", async (enabled) => {
    h.getStatus.mockResolvedValue({ enabled });
    mount(); await ready();
    expect(h.switches).toHaveLength(1);
    expect(h.switches[0].checked).toBe(true);
    const html = render();
    expect(html).not.toContain(">cua<");
    expect(html).not.toContain("cua-stdio-relay.cjs");
    expect(html).toContain(">other<");
    expect(html).toContain("enabled=1/1");
    expect(h.setConfig).not.toHaveBeenCalled();
    await button("Claw.Common.save").onClick();
    expect(h.setConfig).toHaveBeenCalledWith(config);
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("preserves the hidden MCP entry when editing another server", async () => {
    mount(); await ready();
    h.switches[0].onChange(false);
    expect(render()).toContain("enabled=0/1");
    expect(h.setConfig).not.toHaveBeenCalled();
    await button("Claw.Common.save").onClick();
    expect(h.setConfig).toHaveBeenCalledWith({ mcpServers: {
      cua: config.mcpServers.cua,
      other: { ...config.mcpServers.other, enabled: false },
    } });
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it.each([true, false])("leaves the hidden entry unchanged during Disable All with cua.enabled=%s", async (enabled) => {
    const saved = structuredClone(config);
    saved.mcpServers.cua.enabled = enabled;
    h.getConfig.mockResolvedValue(saved);
    mount(); await ready();
    button("Claw.MCP.list.disableAll").onClick();
    expect(render()).toContain("enabled=0/1");
    await button("Claw.Common.save").onClick();
    expect(h.setConfig).toHaveBeenCalledWith({ mcpServers: {
      cua: saved.mcpServers.cua,
      other: { ...saved.mcpServers.other, enabled: false },
    } });
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("shows an empty user list when only the managed entry exists, while preserving it on save", async () => {
    h.getConfig.mockResolvedValue({ mcpServers: { " CUA ": config.mcpServers.cua } });
    mount(); await ready();
    const html = render();
    expect(html).toContain("Claw.MCP.serverManagement.noServers");
    expect(html).toContain("enabled=0/0");
    expect(h.switches).toHaveLength(0);
    await button("Claw.Common.save").onClick();
    expect(h.setConfig).toHaveBeenCalledWith({ mcpServers: { " CUA ": config.mcpServers.cua } });
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("keeps the hidden entry when the last visible server is deleted", async () => {
    mount(); await ready();
    h.buttons.find(props => props.danger && props.onClick)?.onClick();
    render();
    expect(h.switches).toHaveLength(0);
    await button("Claw.Common.save").onClick();
    expect(h.setConfig).toHaveBeenCalledWith({ mcpServers: { cua: config.mcpServers.cua } });
    expect(h.setEnabled).not.toHaveBeenCalled();
  });
});
