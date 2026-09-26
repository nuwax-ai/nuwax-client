import { describe, expect, it } from "vitest";
import {
  diagnosticPageUrl,
  guestFailureCopy,
  mainDocumentFailure,
} from "./webviewLoadFailure";

describe("guest document failure", () => {
  it("ignores iframe failures and navigations aborted by a newer load", () => {
    expect(
      mainDocumentFailure({ isMainFrame: false, errorCode: -105 })
    ).toBeNull();
    expect(mainDocumentFailure({ errorCode: -105 })).toBeNull();
    expect(
      mainDocumentFailure({ isMainFrame: true, errorCode: -3 })
    ).toBeNull();
  });
  it("keeps main-document errors visible without account or ticket parameters", () => {
    expect(
      mainDocumentFailure({
        isMainFrame: true,
        errorCode: -102,
        validatedURL: "https://user:pass@test.example/Login?ticket=secret#key",
      })
    ).toEqual({
      kind: "load",
      code: -102,
      url: "https://test.example/Login",
    });
    expect(diagnosticPageUrl("file:///private/secret")).toBe("");
    expect(diagnosticPageUrl("garbage")).toBe("");
  });
  it("offers recovery text in the current shell language", () => {
    expect(guestFailureCopy("en-US", "load").retry).toBe("Reload page");
    expect(guestFailureCopy("zh-cn", "crash").title).toBe("页面已中断");
    expect(guestFailureCopy("zh-TW", "resolve").retry).toBe("重新載入");
  });
});
