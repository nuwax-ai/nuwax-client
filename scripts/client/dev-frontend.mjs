import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.mjs';
import { buildFrontend } from './frontend.mjs';

/** Preserve the PC Web checkout's dist, including WIP, while building a private client preview. */
export async function prepareDevelopmentFrontend(root, options = {}) {
  const tools = options.tools ?? core;
  const p = tools.paths(root);
  const directory = path.join(p.cache, 'dev');
  fs.mkdirSync(directory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(directory, 'frontend-'));
  const original = path.join(p.frontend, 'dist');
  const backup = path.join(staging, 'original-dist');
  const output = path.join(staging, 'dist');
  let existed = false;
  try { fs.lstatSync(original); existed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let moved = false;
  let building = false;
  let ready = false;
  try {
    if (existed) { fs.renameSync(original, backup); moved = true; }
    building = true;
    const result = await (options.buildFrontend ?? buildFrontend)(root, {
      tools, restoreGenerated: true, cleanDist: false,
    });
    if (path.resolve(result.distDir) !== path.resolve(original))
      throw new Error('[dev] frontend build returned an unexpected output directory');
    fs.renameSync(original, output);
    ready = true;
    return { ...result, distDir: output, dispose: () => fs.rmSync(staging, { recursive: true, force: true }) };
  } finally {
    // No build output may replace developer-owned dist bytes, even after failure.
    if (building) fs.rmSync(original, { recursive: true, force: true });
    if (moved) fs.renameSync(backup, original);
    if (!ready) fs.rmSync(staging, { recursive: true, force: true });
  }
}
