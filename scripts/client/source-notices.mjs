/** Generate an offline inventory of independently shipped components.
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
  const nativeManifest = JSON.parse(fs.readFileSync(path.join(root, 'third-party/manifest.json'), 'utf8'));
  const resourcesDir = options.resourcesDir ?? path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources');
  const resourceComponents = Object.entries(sourceManifest.components).filter(([, entry]) => entry.resourceDirectory !== undefined);
  for (const [name, entry] of resourceComponents) {
    if (entry.resourceDirectory !== name || !/^[a-z0-9-]+$/.test(name) || nativeManifest.resources?.[name]) throw new Error('[third-party] Conflicting independent resource: ' + name);
  }
  const independent = new Set(resourceComponents.map(([name]) => name));
  let paths = options.resourcePaths;
  if (independent.size && !paths) {
    paths = Object.fromEntries(fs.existsSync(resourcesDir) ? fs.readdirSync(resourcesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => [entry.name, path.join(resourcesDir, entry.name)]) : []);
    const capture = path.join(root, 'resources/capture', `${options.platform ?? process.platform}-${options.arch ?? process.arch}`);
    if (fs.existsSync(capture)) paths.capture = capture;
  }
  const selected = Object.fromEntries(Object.entries(sourceManifest.components).filter(([name, entry]) =>
    !entry.resourceDirectory || !paths || Object.hasOwn(paths, name)));
  const binaryIds = new Set(Object.entries(selected).filter(([id]) => independent.has(id))
    .flatMap(([id, entry]) => [entry.id ?? id, ...(entry.components ?? []).map(component => component.id)]));
  const sources = buildNotices({ root, manifest: { resources: selected, allow: sourceManifest.allow }, npmComponents: [], platform: options.platform ?? process.platform });
  if (options.strict && sources.problems.length) throw new Error('[third-party] Vendored source admission failed: ' + sources.problems.map(problem => `${problem.code}:${problem.id}`).join(', '));
  const result = generateNativeNotices(root, { ...options, ...(paths ? { resourcePaths: Object.fromEntries(Object.entries(paths).filter(([name]) => !independent.has(name))) } : {}) });
  const ids = new Set(result.components.map(component => component.id));
  for (const component of sources.components) {
    if (ids.has(component.id)) throw new Error('[third-party] Duplicate vendored-source component: ' + component.id);
    ids.add(component.id);
    result.components.push({ ...component, kind: binaryIds.has(component.id) ? 'binary' : 'framework' });
  }
  result.problems.push(...sources.problems);
  result.document = writeNotices(result, result.outDir);
  return result;
}
