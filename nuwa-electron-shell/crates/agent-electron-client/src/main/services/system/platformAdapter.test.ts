import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformAdapter,
  getCurrentPlatform,
  isSupportedPlatform,
} from "./platformAdapter";

describe("platformAdapter", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  it("should expose Windows command probe traits", () => {
    const adapter = createPlatformAdapter("win32");

    expect(adapter.isWindows).toBe(true);
    expect(adapter.pathDelimiter).toBe(";");
    expect(adapter.getCommandProbe("git")).toEqual({
      command: "where",
      args: ["git"],
    });
  });

  it("should expose Unix command probe traits for macOS", () => {
    const adapter = createPlatformAdapter("darwin");

    expect(adapter.isMacOS).toBe(true);
    expect(adapter.pathDelimiter).toBe(":");
    expect(adapter.getCommandProbe("git")).toEqual({
      command: "which",
      args: ["git"],
    });
  });

  it("should classify supported platforms and fallback current platform", () => {
    expect(isSupportedPlatform("darwin")).toBe(true);
    expect(isSupportedPlatform("linux")).toBe(true);
    expect(isSupportedPlatform("win32")).toBe(true);
    expect(isSupportedPlatform("freebsd")).toBe(false);

    Object.defineProperty(process, "platform", {
      value: "freebsd",
      writable: true,
      configurable: true,
    });
    expect(getCurrentPlatform()).toBe("linux");
  });
});
