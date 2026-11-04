import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRootByFs = path.resolve(testFileDir, '..', '..');
const require = createRequire(import.meta.url);
const { getProjectRoot, resolveFromProject } = require(path.join(
  projectRootByFs,
  'scripts',
  'utils',
  'project-paths.js',
));

describe('scripts project path contracts', () => {
  it('resolves Electron client root correctly', () => {
    const root = getProjectRoot();
    expect(root).toBe(projectRootByFs);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts'))).toBe(true);
  });

  it('resolves resources and node_modules from project root', () => {
    expect(resolveFromProject('resources')).toBe(path.join(projectRootByFs, 'resources'));
    expect(resolveFromProject('node_modules')).toBe(path.join(projectRootByFs, 'node_modules'));
  });
});
