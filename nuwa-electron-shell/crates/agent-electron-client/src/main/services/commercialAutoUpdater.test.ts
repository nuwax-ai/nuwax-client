import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import vm from "node:vm";
import path from "node:path";

// Exercise the packaged CJS module boundary: the base initializer and the
// commercial adapter must configure the same electron-updater singleton.
function initializeWithBasePolicy(baseDisablesDiff: boolean) {
  const updater = { disableDifferentialDownload: true };
  const calls: unknown[][] = [];
  const source = buildSync({
    entryPoints: [path.resolve("src/main/services/commercialAutoUpdater.ts")],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["./autoUpdater", "electron-updater", "electron-log"],
  }).outputFiles[0].text;
  const module = { exports: {} as { initAutoUpdater: (...args: unknown[]) => void } };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: (name: string) => {
      if (name === "./autoUpdater") return { initAutoUpdater: (...args: unknown[]) => {
        calls.push(args); updater.disableDifferentialDownload = baseDisablesDiff;
      } };
      if (name === "electron-updater") return { autoUpdater: updater };
      if (name === "electron-log") return { info() {} };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const window = () => null, cleanup = async () => {}, beforeInstall = () => {};
  const options = { installAfterDownload: true };
  module.exports.initAutoUpdater(window, cleanup, beforeInstall, options);
  return { updater, calls, expectedArgs: [window, cleanup, beforeInstall, options] };
}

describe("commercial full-package update policy", () => {
  it("overrides the macOS base default after initialization", () => {
    const { updater, calls, expectedArgs } = initializeWithBasePolicy(false);
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(calls).toEqual([expectedArgs]);
  });

  it("keeps the existing Windows full-package behavior", () => {
    const { updater, calls } = initializeWithBasePolicy(true);
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
