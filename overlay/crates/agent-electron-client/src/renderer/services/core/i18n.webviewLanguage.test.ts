import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiRequest, changeLanguage } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => ({ code: "0000", data: [] })),
  changeLanguage: vi.fn(async () => undefined),
}));
vi.mock("./api", () => ({ apiRequest }));
vi.mock("../i18n", () => ({ default: { changeLanguage } }));
vi.mock("@shared/constants", () => ({ APP_NAME_IDENTIFIER: "nuwax" }));
let settings: Map<string, unknown>;
let setLang: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  settings = new Map();
  setLang = vi.fn();
  changeLanguage.mockClear();
  vi.stubGlobal("window", { electronAPI: {
    settings: { get: vi.fn(async (key: string) => settings.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => settings.set(key, value)) },
    i18n: { setLang },
  } });
});

describe("commercial webview language mirror", () => {
  it("ignores old shell choice on first launch and defaults to Chinese", async () => {
    settings.set("i18n.active_lang", "en-us");
    const lang = await import("./i18n");
    await lang.initI18n();
    expect(lang.getCurrentLang()).toBe("zh-cn");
    expect(changeLanguage).toHaveBeenCalledWith("zh-cn");
    expect(setLang).not.toHaveBeenCalled();
  });
  it("restores last guest language on restart", async () => {
    settings.set("nuwax.webview_lang", "en-us");
    const lang = await import("./i18n");
    await lang.initI18n();
    expect(lang.getCurrentLang()).toBe("en-us");
    expect(changeLanguage).toHaveBeenCalledWith("en-us");
    expect(setLang).not.toHaveBeenCalled();
  });
  it("switches both directions and keeps unsupported fallback within shell", async () => {
    const lang = await import("./i18n");
    await lang.setCurrentLang("en-US");
    expect(lang.getCurrentLang()).toBe("en-us");
    await lang.setCurrentLang("zh-TW");
    expect(lang.getCurrentLang()).toBe("zh-tw");
    await lang.setCurrentLang("ja-JP");
    expect(lang.getCurrentLang()).toBe("zh-cn");
    expect(setLang).not.toHaveBeenCalled();
  });
  it("late earlier setting completion cannot revert a newer language", async () => {
    const lang = await import("./i18n");
    let finishOld!: () => void;
    vi.mocked(window.electronAPI.settings.set).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { finishOld = resolve; }) as never,
    );
    const old = lang.setCurrentLang("en-us");
    await lang.setCurrentLang("zh-cn");
    finishOld();
    await old;
    expect(lang.getCurrentLang()).toBe("zh-cn");
    expect(changeLanguage.mock.calls).toEqual([["zh-cn"]]);
  });

});
