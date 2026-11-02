import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { HARNESS_ACP_PACKAGE, resolveHarnessAcp } from "../src/index.js";

describe("Nuwax Harness resolution", () => {
  it("resolves the installed adapter with the same ESM and CJS contract", () => {
    const require = createRequire(import.meta.url);
    const cjs = require("../dist/index.cjs");
    const entry = require.resolve(`${HARNESS_ACP_PACKAGE}/dist/index.js`);
    const expected = { command: process.execPath, args: [entry] };
    expect(resolveHarnessAcp()).toEqual(expected);
    expect(cjs.resolveHarnessAcp()).toEqual(expected);
  });

  it("uses the host's bundled adapter entry", () => {
    expect(
      resolveHarnessAcp({
        entryOverride: "/resources/nuwax-harness-acp-ts/dist/index.js",
      }),
    ).toEqual({
      command: process.execPath,
      args: ["/resources/nuwax-harness-acp-ts/dist/index.js"],
    });
  });
});
