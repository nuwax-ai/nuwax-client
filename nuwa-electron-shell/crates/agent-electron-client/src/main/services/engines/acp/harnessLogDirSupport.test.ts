import { describe, expect, it } from "vitest";

import {
    HARNESS_LOG_DIR_MIN_ADAPTER_VERSION,
    adapterSupportsHarnessLogDir,
    parseAdapterVersion,
} from "./harnessLogDirSupport";

describe("parseAdapterVersion", () => {
    it("parses a plain release", () => {
        expect(parseAdapterVersion("1.2.59")).toEqual([1, 2, 59]);
    });

    it("ignores prerelease and build metadata", () => {
        expect(parseAdapterVersion("1.2.59-beta.3")).toEqual([1, 2, 59]);
        expect(parseAdapterVersion("1.2.59+build.7")).toEqual([1, 2, 59]);
    });

    it("rejects anything it cannot read", () => {
        expect(parseAdapterVersion(undefined)).toBeNull();
        expect(parseAdapterVersion("")).toBeNull();
        expect(parseAdapterVersion("v1.2.59")).toBeNull();
        expect(parseAdapterVersion("latest")).toBeNull();
    });
});

describe("adapterSupportsHarnessLogDir", () => {
    it("accepts the first supporting version and anything newer", () => {
        expect(adapterSupportsHarnessLogDir(HARNESS_LOG_DIR_MIN_ADAPTER_VERSION)).toBe(true);
        expect(adapterSupportsHarnessLogDir("1.2.60")).toBe(true);
        expect(adapterSupportsHarnessLogDir("1.3.0")).toBe(true);
        expect(adapterSupportsHarnessLogDir("2.0.0")).toBe(true);
    });

    it("rejects older releases, which ignore the variable", () => {
        expect(adapterSupportsHarnessLogDir("1.2.58")).toBe(false);
        expect(adapterSupportsHarnessLogDir("1.1.99")).toBe(false);
        expect(adapterSupportsHarnessLogDir("0.9.0")).toBe(false);
    });

    it("treats an unreadable version as unsupported", () => {
        expect(adapterSupportsHarnessLogDir(undefined)).toBe(false);
        expect(adapterSupportsHarnessLogDir("workspace:*")).toBe(false);
    });
});
