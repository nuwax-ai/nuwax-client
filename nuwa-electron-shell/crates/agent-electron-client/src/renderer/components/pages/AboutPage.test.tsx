import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  channel: "stable",
  switches: [] as { checked: boolean; onChange: (value: boolean) => Promise<void> }[],
  confirm: vi.fn(), save: vi.fn(), success: vi.fn(), error: vi.fn(), check: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => actual.useState(initial === "stable" ? h.channel : initial) };
});
vi.mock("antd", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  Progress: () => null,
  Switch: (props: typeof h.switches[number]) => { h.switches.push(props); return null; },
  Modal: { confirm: h.confirm },
  message: { success: h.success, error: h.error, info: vi.fn() },
}));
vi.mock("../../services/core/i18n", () => ({ t: (key: string) => key }));
import AboutPage from "./AboutPage";

beforeEach(() => {
  h.channel = "stable"; h.switches = [];
  h.confirm.mockReset(); h.save.mockReset().mockResolvedValue(true);
  h.success.mockReset(); h.error.mockReset(); h.check.mockReset();
  vi.stubGlobal("window", { electronAPI: { settings: { set: h.save }, app: { checkUpdate: h.check } } });
});
afterEach(() => vi.unstubAllGlobals());

it.each(["stable", "beta", "dev"])("shows nested switches for %s", (channel) => {
  h.channel = channel;
  const html = renderToStaticMarkup(<AboutPage />);
  expect(html.includes("Claw.About.devChannel")).toBe(channel !== "stable");
  expect(h.switches.map(({ checked }) => checked)).toEqual(channel === "stable" ? [false] : [true, channel === "dev"]);
});

it("requires explicit confirmation to enable Dev", async () => {
  h.channel = "beta"; renderToStaticMarkup(<AboutPage />);
  await h.switches[1].onChange(true);
  expect(h.save).not.toHaveBeenCalled();
  await h.confirm.mock.calls[0][0].onOk();
  expect(h.save).toHaveBeenCalledWith("update_channel", "dev");
  expect(h.check).toHaveBeenCalledOnce();
});

it.each([[0, "stable"], [1, "beta"]] as const)("exits Dev using switch %s", async (index, expected) => {
  h.channel = "dev"; renderToStaticMarkup(<AboutPage />);
  await h.switches[index].onChange(false);
  expect(h.save).toHaveBeenCalledWith("update_channel", expected);
  expect(h.confirm).not.toHaveBeenCalled();
});

it("reports a rejected setting write without pretending it succeeded", async () => {
  h.channel = "dev"; h.save.mockResolvedValue(false); renderToStaticMarkup(<AboutPage />);
  await h.switches[1].onChange(false);
  expect(h.success).not.toHaveBeenCalled();
  expect(h.error).toHaveBeenCalledWith("Claw.About.channelSwitchFailed");
  expect(h.check).not.toHaveBeenCalled();
});
