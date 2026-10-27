/** Pure observability helpers for the build-resource pipeline.
 * Deliberately NOT a cache-recipe member: this file never influences
 * produced bytes, so edits here (annotations, summaries, log format) must
 * not invalidate any native-resource cache. Keep it free of build logic. */
import fs from 'node:fs';

export function output(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

export function report(kind, state, started, detail = '') {
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  const clean = String(detail).replace(/[\r\n|]/g, ' ').slice(0, 500);
  console.log(`[build-resource] ${kind}: ${state}; ${seconds}s; ${clean}`);
  // MISS/invalidated 会让 macOS 构建多付 ~30 分钟冷编（v3.0.23-beta.9 实测）。
  // 以 annotation 浮到 run 页面，缓存回归不再只埋在日志里。
  if (process.env.GITHUB_ACTIONS && /^(MISS|invalidated)/.test(state)) {
    console.log(`::warning::build-resource ${kind} ${state} — ${seconds}s; ${clean}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n- Build resource **${kind}**: **${state}**, ${seconds}s. ${clean}\n`);
}
