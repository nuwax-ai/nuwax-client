import { describe, expect, it } from "vitest";
import path from "node:path";
import vm from "node:vm";
import { buildSync } from "esbuild";

const { brandingDefines } = require("../../scripts/build/branding-defines.cjs");
const env = { NUWAX_APP_IDENTIFIER: "nuwax", NUWAX_APP_DISPLAY_NAME: "女娲Nuwax", NUWAX_DEV_PROFILE: "1" };

function compiledIdentity(development: boolean, environment = env) {
  const result = buildSync({
    stdin: { contents: 'export { APP_NAME_IDENTIFIER, APP_DISPLAY_NAME, APP_DATA_DIR_NAME, IS_DEV_PROFILE } from "./src/shared/constants"',
      resolveDir: path.resolve(__dirname, "../.."), loader: "ts" },
    bundle: true, write: false, format: "cjs", platform: "browser",
    define: brandingDefines(environment, development),
  });
  // No process object: the renderer must receive the same static identity as main/preload.
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
  return module.exports;
}

describe("compiled commercial profile identity", () => {
  it("isolates the development data while preserving commercial authentication guards", () => {
    expect(compiledIdentity(true)).toMatchObject({ APP_NAME_IDENTIFIER: "nuwax", APP_DISPLAY_NAME: "女娲Nuwax Dev",
      APP_DATA_DIR_NAME: ".nuwax-dev", IS_DEV_PROFILE: true });
  });
  it("production strips a development switch inherited from the build machine", () => {
    expect(compiledIdentity(false)).toMatchObject({ APP_NAME_IDENTIFIER: "nuwax", APP_DISPLAY_NAME: "女娲Nuwax",
      APP_DATA_DIR_NAME: ".nuwax", IS_DEV_PROFILE: false });
  });
  it("does not move existing commercial or community profiles when the switch is absent", () => {
    expect(compiledIdentity(true, { ...env, NUWAX_DEV_PROFILE: "" }).APP_DATA_DIR_NAME).toBe(".nuwax");
    expect(compiledIdentity(true, { ...env, NUWAX_APP_IDENTIFIER: "nuwaclaw" }).APP_DATA_DIR_NAME).toBe(".nuwaclaw");
  });
});
