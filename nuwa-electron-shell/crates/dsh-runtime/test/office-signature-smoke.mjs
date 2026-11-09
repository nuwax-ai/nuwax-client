import assert from 'node:assert/strict'
import { copyFile, chmod, mkdtemp, mkdir, writeFile, access, rm, readFile, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

/** Exercise conversion with the production hardened-runtime permissions, then
 * restore the installed test dependency byte-for-byte. Resource staging installs
 * its own clean dependencies; this never changes a prepared app payload. */
export async function prepareSignedOffice() {
  const require = createRequire(import.meta.url)
  const kit = createRequire(require.resolve('@deepseek-ai/libreoffice-kit'))
  const directory = dirname(kit.resolve(`@deepseek-ai/libreoffice-kit-darwin-${process.arch}/package.json`))
  const manifest = JSON.parse(await readFile(join(directory, 'prebuilds.json'), 'utf8'))
  const executable = join(directory, manifest.engine.executable)
  const { entitlementsForNative } = require('../../agent-electron-client/scripts/build/dsh-sign-resources.cjs')
  const entitlements = entitlementsForNative(executable)
  assert.ok(entitlements, 'Office native signing permissions are required')
  const original = await readFile(executable)
  const mode = (await stat(executable)).mode & 0o777
  const temporary = executable + '.nuwax-smoke-' + process.pid
  try {
    await copyFile(executable, temporary)
    await execute('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, temporary])
    await execute('codesign', ['--verify', '--strict', temporary])
    await rename(temporary, executable)
  } catch (error) { await rm(temporary, { force: true }); throw error }
  return async () => {
    // Replace the inode rather than writing a previously executed Mach-O file.
    await writeFile(temporary, original, { mode })
    await rename(temporary, executable)
  }
}

/** Verify the actual macOS resource seal around a bundled Python import. */
export async function verifySignedPython(python) {
  const root = await mkdtemp(join(tmpdir(), 'nuwax-office-signature-'))
  try {
    const app = join(root, 'Probe.app'), contents = join(app, 'Contents'), resources = join(contents, 'Resources')
    await mkdir(resources, { recursive: true }); await mkdir(join(contents, 'MacOS'))
    await copyFile('/usr/bin/true', join(contents, 'MacOS/Probe')); await chmod(join(contents, 'MacOS/Probe'), 0o755)
    await writeFile(join(contents, 'Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.nuwax.office-signature-probe</string><key>CFBundleExecutable</key><string>Probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    await writeFile(join(resources, 'nuwax_office_probe.py'), 'VALUE = 42\n')
    const baseline = { ...process.env }; delete baseline.PYTHONDONTWRITEBYTECODE; delete baseline.PYTHONPYCACHEPREFIX
    const run = env => execute(python, ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);import nuwax_office_probe;assert nuwax_office_probe.VALUE==42', resources], { env })
    const sign = () => execute('codesign', ['--force', '--sign', '-', app])
    const verify = () => execute('codesign', ['--verify', '--deep', '--strict', app])
    await sign(); await verify(); await run(baseline)
    await access(join(resources, '__pycache__'))
    await assert.rejects(verify(), 'unprotected Python import must demonstrate the resource-seal regression')
    await rm(join(resources, '__pycache__'), { recursive: true }); await sign()
    await run({ ...baseline, PYTHONDONTWRITEBYTECODE: '1' })
    await assert.rejects(access(join(resources, '__pycache__')))
    await verify()
    console.log(JSON.stringify({ level: 'macos-sealed-python-import', baselineSealBroken: true, protectedSealValid: true }))
  } finally { await rm(root, { recursive: true, force: true }) }
}
