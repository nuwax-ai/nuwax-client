/** Merge vendored JavaScript source notices only at the application-packaging boundary.
 * Native capture recipes deliberately keep using third-party-notices.mjs unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildNotices, generateThirdPartyNotices as generateNativeNotices, writeNotices } from './third-party-notices.mjs';

export function generateThirdPartyNotices(root, options = {}) {
  if (options.captureOnly) return generateNativeNotices(root, options);
  const file = path.join(root, 'third-party/source-components.json');
  if (!fs.existsSync(file)) return generateNativeNotices(root, options);
  const sourceManifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (sourceManifest.schema !== 1 || !sourceManifest.components || typeof sourceManifest.components !== 'object' || Array.isArray(sourceManifest.components)) throw new Error('[third-party] Invalid vendored-source manifest');
  const sources = buildNotices({ root, manifest: { resources: sourceManifest.components }, npmComponents: [], platform: options.platform ?? process.platform });
  if (options.strict && sources.problems.length) throw new Error('[third-party] Vendored source admission failed: ' + sources.problems.map(problem => `${problem.code}:${problem.id}`).join(', '));
  const result = generateNativeNotices(root, options);
  const ids = new Set(result.components.map(component => component.id));
  for (const component of sources.components) {
    if (ids.has(component.id)) throw new Error('[third-party] Duplicate vendored-source component: ' + component.id);
    ids.add(component.id);
    result.components.push({ ...component, kind: 'framework' });
  }
  result.problems.push(...sources.problems);
  result.document = writeNotices(result, result.outDir);
  return result;
}
