import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const i = hooks.cursor++;
    hooks.slots[i] ??= { value: initial };
    return [hooks.slots[i].value, (value: unknown) => { hooks.slots[i].value = value; }];
  },
  useEffect(effect: () => void, _deps: unknown[]) {
    const i = hooks.cursor++;
    if (!hooks.slots[i]) { hooks.slots[i] = true; hooks.effects.push(effect); }
  },
}));
import { HostRecovery } from "./PageLoadRecovery";

function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
function render() { hooks.cursor = 0; return HostRecovery({ lang: "zh-CN" }); }
function button(tree: any, label: string) {
  return find(tree, node => node.type === "button" && node.props.children === label);
}
afterEach(() => { hooks.slots = []; hooks.effects = []; vi.unstubAllGlobals(); });

describe("recovery service address", () => {
  it("offers the previous address, warns before override and requests a restart", async () => {
    const configure = vi.fn().mockResolvedValueOnce({ success: false, probe: "dns" }).mockResolvedValueOnce({ success: true });
    vi.stubGlobal("window", { electronAPI: {
      settings: { get: async (key: string) => key === "step1_config" ? { serverHost: "https://bad.example" } : "https://old.example" },
      services: { configureServerHost: configure },
    } });
    render();
    hooks.effects.splice(0).forEach(effect => effect());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    let tree = render();
    button(tree, "改回上一个地址").props.onClick();
    tree = render();
    expect(find(tree, node => node.type === "input").props.value).toBe("https://old.example");
    find(tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
    await Promise.resolve(); await Promise.resolve();
    expect(configure).toHaveBeenCalledWith("https://old.example", { allowUnreachable: false, restart: true });
    tree = render();
    expect(button(tree, "仍要保存并重启")).toBeTruthy();
    button(tree, "仍要保存并重启").props.onClick();
    await Promise.resolve(); await Promise.resolve();
    expect(configure).toHaveBeenLastCalledWith("https://old.example", { allowUnreachable: true, restart: true });
  });
});
