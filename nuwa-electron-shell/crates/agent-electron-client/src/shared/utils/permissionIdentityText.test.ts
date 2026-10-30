import { describe, expect, it } from "vitest";
import { permissionIdentityText } from "./permissionIdentityText";

describe("permission subjects", () => {
  it("distinguishes development grants while leaving other formatting placeholders intact", () => {
    const template = "{computerUseHelper} / {clientApplication}: {error} {0}";
    expect(permissionIdentityText(template, true)).toBe("Nuwax Computer Use Dev / Nuwax Dev.app: {error} {0}");
    expect(permissionIdentityText(template)).toBe("Nuwax Computer Use / Nuwax.app: {error} {0}");
  });
});
