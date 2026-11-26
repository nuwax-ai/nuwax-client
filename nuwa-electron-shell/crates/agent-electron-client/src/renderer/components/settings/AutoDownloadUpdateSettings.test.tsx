import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  mounted: false,
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  control: null as any,
  get: vi.fn(),
  set: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.values))
      h.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.values[index],
      (value: unknown) => {
        h.values[index] =
          typeof value === "function" ? value(h.values[index]) : value;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (!h.mounted) h.effects.push(effect);
  },
}));
vi.mock("antd", () => ({
  Switch: (props: any) => {
    h.control = props;
    return <input role="switch" checked={props.checked} readOnly />;
  },
  message: { error: h.error, success: h.success },
}));
import { AutoDownloadUpdateSettings } from "./AutoDownloadUpdateSettings";

const t = (key: string) => key;
const Row = ({ label, desc, control }: any) => (
  <section>
    {label}
    <p>{desc}</p>
    {control}
  </section>
);
function render() {
  h.cursor = 0;
  const html = renderToStaticMarkup(
    <AutoDownloadUpdateSettings t={t} Row={Row} />,
  );
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
const ready = () =>
  vi.waitFor(() => {
    render();
    expect(h.control.disabled).toBe(false);
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.values = [];
  h.cursor = 0;
  h.mounted = false;
  h.effects = [];
  h.cleanups = [];
  h.get.mockResolvedValue(null);
  h.set.mockResolvedValue(true);
  vi.stubGlobal("window", {
    electronAPI: { settings: { get: h.get, set: h.set } },
  });
});
afterEach(() => {
  h.cleanups.forEach((off) => off());
  vi.unstubAllGlobals();
});

describe("自动下载更新设置", () => {
  it.each([null, false, "true"])(
    "默认关闭，仅显式 true 开启：%s",
    async (value) => {
      h.get.mockResolvedValue(value);
      mount();
      await ready();
      expect(h.get).toHaveBeenCalledWith("update_auto_download");
      expect(h.control.checked).toBe(false);
      expect(h.set).not.toHaveBeenCalled();
      expect(render()).toContain("Claw.Settings.system.autoDownloadUpdateDesc");
    },
  );

  it("保留已保存的开启状态，切换即时保存并可重新开启", async () => {
    h.get.mockResolvedValue(true);
    mount();
    await ready();
    expect(h.control.checked).toBe(true);
    for (const checked of [false, true]) {
      h.control.onChange(checked);
      await vi.waitFor(() => {
        render();
        expect(h.control.checked).toBe(checked);
      });
      expect(h.set).toHaveBeenLastCalledWith("update_auto_download", checked);
    }
  });

  it.each([false, new Error("write failed")])(
    "保存失败保留关闭状态：%s",
    async (failure) => {
      if (failure === false) h.set.mockResolvedValue(false);
      else h.set.mockRejectedValue(failure);
      mount();
      await ready();
      h.control.onChange(true);
      await vi.waitFor(() =>
        expect(h.error).toHaveBeenCalledWith(
          "Claw.Toast.Error.configSaveFailed",
        ),
      );
      render();
      expect(h.control.checked).toBe(false);
      expect(h.control.disabled).toBe(false);
    },
  );

  it("读取失败禁用开关并提示，不覆盖未知设置", async () => {
    h.get.mockRejectedValue(new Error("read failed"));
    mount();
    await vi.waitFor(() =>
      expect(h.error).toHaveBeenCalledWith("Claw.Toast.Error.loadFailed"),
    );
    render();
    expect(h.control.disabled).toBe(true);
    expect(h.control.checked).toBe(false);
    expect(h.set).not.toHaveBeenCalled();
  });
});
