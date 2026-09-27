import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getLocale: () => "en-US",
  },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn() },
}));

import { getMainLang, initI18n, onMainLangChanged, setMainLang, t } from "./i18n";

describe("主进程语言变更订阅", () => {
  const unsubscribers: Array<() => void> = [];
  beforeEach(() => {
    initI18n();
    setMainLang("zh-cn");
  });
  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  });

  it("通知发生时新字典已就绪，大小写同值不重复通知", () => {
    const listener = vi.fn((lang) => [lang, getMainLang(), t("Claw.NativeMenu.file")]);
    unsubscribers.push(onMainLangChanged(listener));
    setMainLang("EN-US");
    setMainLang("en-us");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.results[0].value).toEqual(["en-us", "en-us", "File"]);
  });

  it("取消订阅后不再收到切换通知", () => {
    const listener = vi.fn();
    const unsubscribe = onMainLangChanged(listener);
    unsubscribe();
    setMainLang("en-us");
    expect(listener).not.toHaveBeenCalled();
  });

  it("某个订阅者抛错不会中断语言切换或其它订阅者", () => {
    unsubscribers.push(onMainLangChanged(() => { throw new Error("listener failed"); }));
    const listener = vi.fn();
    unsubscribers.push(onMainLangChanged(listener));
    expect(() => setMainLang("zh-TW")).not.toThrow();
    expect(listener).toHaveBeenCalledWith("zh-tw");
    expect(t("Claw.NativeMenu.file")).toBe("檔案");
  });
});
