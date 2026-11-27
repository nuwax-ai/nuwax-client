import { describe, expect, it } from "vitest";
import { isValidServiceHostInput } from "./serviceHostInput";

describe("service address input", () => {
  it.each(["intranet", "server.internal:8443", "http://127.0.0.1:3000", "https://[::1]:443"])("allows %s", value => {
    expect(isValidServiceHostInput(value)).toBe(true);
  });
  it.each(["", "bad domain", "ftp://example.com", "https://user:pass@example.com"])("rejects %s", value => {
    expect(isValidServiceHostInput(value)).toBe(false);
  });
});
