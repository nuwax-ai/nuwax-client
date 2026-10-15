#!/usr/bin/env node
// Bundles the TypeScript harness with the repo's esbuild and runs it. See README.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
// CU_ESBUILD lets a baseline copy of the repo (no installed dependencies) reuse another checkout's esbuild.
const esbuild = process.env.CU_ESBUILD ?? path.join(root, "nuwa-electron-shell/crates/agent-electron-client/node_modules/.bin/esbuild");
const outDir = "/tmp/cu-bench";
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, "harness.cjs");
execFileSync(esbuild, [path.join(here, "harness.ts"), "--bundle", "--platform=node", "--format=cjs",
  `--outfile=${outfile}`, `--alias:@shared=${path.join(root, "overlay/crates/agent-electron-client/src/shared")}`, "--log-level=warning"], { stdio: "inherit" });
process.env.CU_BENCH_DIR = here;
const { main } = await import(pathToFileURL(outfile).href);
await main(process.argv.slice(2));
process.exit(0);
