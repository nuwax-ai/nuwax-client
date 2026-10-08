import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// WiX still uses legacy path access. Keep version in metadata/asset names,
// and use one short output for packaging, provenance and artifact uploads.
export function configureWindowsOutput({ packagePath, env = process.env }) {
  const { RUNNER_TEMP: temp, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt,
    TARGET_ARCH: arch, GITHUB_ENV: environmentFile } = env;
  if (!temp || /[\r\n\0]/.test(temp) || !path.win32.isAbsolute(temp)
      || !/^[1-9][0-9]*$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(attempt ?? '')
      || !['x64', 'arm64'].includes(arch) || !environmentFile || !packagePath) {
    throw new Error('Invalid Windows runner output identity');
  }
  const output = path.win32.join(temp, `nw-${runId}-${attempt}-${arch}`).replaceAll('\\', '/');
  if (output.length > 80) throw new Error('Windows runner output prefix exceeds the WiX path budget');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!pkg.build || typeof pkg.build !== 'object') throw new Error('Missing electron-builder configuration');
  pkg.build.directories = { ...pkg.build.directories, output };
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.appendFileSync(environmentFile, `NUWAX_WINDOWS_OUTPUT_DIR=${output}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`Windows Actions output: ${configureWindowsOutput({ packagePath: process.argv[2] })}`);
}
