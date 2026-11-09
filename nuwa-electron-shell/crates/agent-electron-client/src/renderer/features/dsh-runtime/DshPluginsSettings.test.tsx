import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { DshPluginsSettings } from "./DshPluginsSettings";

const harness = vi.hoisted(() => ({ index: 0, values: [] as unknown[],
  buttons: [] as Array<{ label: string; click: () => void }>,
  switches: [] as Array<{ label: string; disabled: boolean; change: (value: boolean) => void }>,
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = harness.index++;
    if (index >= harness.values.length) harness.values.push(initial);
    return [harness.values[index], (value: unknown) => { harness.values[index] = typeof value === "function" ? value(harness.values[index]) : value; }];
  } };
});

vi.mock("antd", () => {
  const Button = ({ children, disabled, onClick }: any) => {
    harness.buttons.push({ label: String(children), click: onClick });
    return <button type="button" disabled={disabled}>{children}</button>;
  };
  const Input = Object.assign((props: any) => <input {...props} />, { TextArea: (props: any) => <textarea {...props} /> });
  const Space = Object.assign(({ children }: any) => <div>{children}</div>, { Compact: ({ children }: any) => <div>{children}</div> });
  const Modal = Object.assign(({ open, children }: any) => open ? <div>{children}</div> : null, { confirm: vi.fn() });
  return { Button, Input, Space, Modal, Alert: ({ message }: any) => <div>{message}</div>, Tag: ({ children }: any) => <span>{children}</span>,
    Switch: ({ checked, disabled, onChange, "aria-label": label }: any) => {
      harness.switches.push({ label, disabled, change: onChange });
      return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} />;
    } };
});

afterEach(() => vi.unstubAllGlobals());

it("uses package availability rather than profile installation for labels and controls", async () => {
  const bundles = [
    { name: "core", availability: "installation", installed: false, enabled: true, protected: true, removable: false },
    { name: "shipped-addon", availability: "installation", installed: false, enabled: false, protected: false, removable: false },
    { name: "missing-addon", availability: "missing", installed: false, enabled: false, protected: false, removable: false },
  ];
  const plugins = vi.fn(async (_operation: string, _input?: unknown) => ({ ok: true, value: { bundles, configuration: [] } }));
  vi.stubGlobal("window", { electronAPI: { dshRuntime: { plugins } } });
  const render = () => {
    harness.index = 0; harness.buttons = []; harness.switches = [];
    return renderToStaticMarkup(<DshPluginsSettings enabled t={key => key} />);
  };
  render();
  harness.buttons.find(button => button.label === "Claw.Dsh.plugins.title")!.click();
  await vi.waitFor(() => expect(render()).toContain("shipped-addon"));
  expect(render().match(/Claw.Dsh.plugins.notInstalled/g)).toHaveLength(1);
  expect(harness.switches.find(item => item.label === "core Claw.Dsh.plugins.enabled")!.disabled).toBe(true);
  expect(harness.switches.find(item => item.label === "missing-addon Claw.Dsh.plugins.enabled")!.disabled).toBe(true);
  const shipped = harness.switches.find(item => item.label === "shipped-addon Claw.Dsh.plugins.enabled")!;
  expect(shipped.disabled).toBe(false);
  expect(plugins.mock.calls.every(call => call[0] === "list")).toBe(true);
  shipped.change(true);
  await vi.waitFor(() => expect(plugins).toHaveBeenCalledWith("enable", { target: "shipped-addon" }));
});
