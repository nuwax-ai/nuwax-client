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
import { LocalFilesSettings } from "./LocalFilesSettings";

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
  const html = renderToStaticMarkup(<LocalFilesSettings t={t} Row={Row} />);
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

describe("本机文件访问设置", () => {
  it("缺省开启，加载不写默认值，提示重启生效", async () => {
    mount();
    await ready();
    expect(h.get).toHaveBeenCalledWith("features.local-files.enabled");
    expect(h.control.checked).toBe(true);
    expect(h.set).not.toHaveBeenCalled();
    expect(render()).toContain("Claw.Settings.localFiles.desc");
  });
  it("保留已保存的关闭值，重新开启只写独立布尔配置", async () => {
    h.get.mockResolvedValue(false);
    mount();
    await ready();
    expect(h.control.checked).toBe(false);
    h.control.onChange(true);
    await vi.waitFor(() => {
      render();
      expect(h.control.checked).toBe(true);
    });
    expect(h.set).toHaveBeenCalledOnce();
    expect(h.set).toHaveBeenCalledWith("features.local-files.enabled", true);
    expect(h.success).toHaveBeenCalledWith(
      "Claw.Settings.localFiles.savedRestart"
    );
  });
  it("保存失败保留原状态，不显示已关闭或保存成功", async () => {
    h.set.mockResolvedValue(false);
    mount();
    await ready();
    h.control.onChange(false);
    await vi.waitFor(() =>
      expect(h.error).toHaveBeenCalledWith("Claw.Toast.Error.configSaveFailed")
    );
    render();
    expect(h.control.checked).toBe(true);
    expect(h.control.disabled).toBe(false);
    expect(h.success).not.toHaveBeenCalled();
  });
  it("读取失败时禁用未知配置，显示失败提示", async () => {
    h.get.mockRejectedValue(new Error("read failed"));
    mount();
    await vi.waitFor(() =>
      expect(h.error).toHaveBeenCalledWith("Claw.Toast.Error.loadFailed")
    );
    render();
    expect(h.control.disabled).toBe(true);
    expect(h.control.loading).toBe(false);
    expect(h.set).not.toHaveBeenCalled();
  });
});
