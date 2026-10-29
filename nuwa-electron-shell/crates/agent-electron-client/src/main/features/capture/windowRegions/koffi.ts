import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** The subset of koffi used by window enumeration; declared here so the feature has no type dependency. */
export interface KoffiLibrary { func(...definition: unknown[]): (...args: any[]) => any }
export interface Koffi {
  load(path: string): KoffiLibrary;
  struct(name: string, members: Record<string, string>): unknown;
  pointer(type: unknown): unknown;
  out(type: unknown): unknown;
  proto(definition: string): unknown;
  register(callback: (...args: any[]) => unknown, type: unknown): unknown;
  unregister(callback: unknown): void;
  decode(pointer: unknown, type: unknown, length?: number): ArrayLike<number | bigint>;
}

interface KoffiRecord { schema: number; platform: string; arch: string; version: string; sha256: string }

export interface CaptureKoffiOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Directory containing the per-platform directories, never a module or PATH lookup. */
  resourceRoot?: string;
}

/**
 * Only the admitted prebuilt module beside the capture encoder is loaded: it stays outside the asar,
 * so the OS never maps a copy extracted to a temporary directory, and an unverified file is refused.
 */
export function loadCaptureKoffi(options: CaptureKoffiOptions = {}): Koffi | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return null;
  let binary: string;
  try {
    const resourceRoot = options.resourceRoot ?? (app.isPackaged
      ? path.join(process.resourcesPath, 'capture')
      : path.resolve(app.getAppPath(), '../../../resources/capture'));
    const directory = path.join(resourceRoot, `${platform}-${arch}`);
    binary = path.join(directory, 'koffi.node');
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'koffi.json'), 'utf8')) as KoffiRecord;
    if (record.schema !== 1 || record.platform !== platform || record.arch !== arch || !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
    if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== record.sha256) return null;
  } catch { return null; }
  // A verified module that still fails to load is a real fault and is reported by the caller.
  const module = { exports: {} as Koffi };
  process.dlopen(module, binary);
  return module.exports;
}
