import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { nativeImage } from 'electron';
import type { CaptureWindowImage } from '@shared/features/capture/windowContract';
import { usesCapturePortal } from '../linuxEnvironment';
import { uosFrameHelper } from './uosFrameHelper';
import { CaptureCanceledError } from '../captureErrors';

export const UOS_DESKTOP_SOURCE = 'screen:uos-desktop';

export interface UosFrame {
  width: number;
  height: number;
  format: 'BGRX' | 'RGBX';
  pixels: Uint8Array;
}

export interface UosFrameSource {
  first: UosFrame;
  next(): Promise<UosFrame>;
  closed: Promise<Error | undefined>;
  dispose(): void;
}

export function supportsUosFrames(platform = process.platform, env = process.env): boolean {
  if (!usesCapturePortal(platform, env) || !env.WAYLAND_DISPLAY || !env.XDG_RUNTIME_DIR ||
      !env.XDG_CURRENT_DESKTOP?.split(':').some(value => /^(deepin|uos)$/i.test(value))) return false;
  try { return /^ID=(?:"uos"|uos)$/m.test(readFileSync('/etc/os-release', 'utf8')); }
  catch { return false; }
}

/** Called for one active capture only. No system configuration or privileges are changed. */
export async function openUosFrames(signal: AbortSignal): Promise<UosFrameSource | null> {
  if (signal.aborted || !supportsUosFrames()) return null;
  const child = spawn('/usr/bin/python3', ['-I', '-u', '-c', uosFrameHelper], {
    env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // Consume errors from spawn, transport and cancellation through the frame reader.
  child.on('error', () => child.stdout.destroy());
  child.stdin.on('error', () => child.stdout.destroy());
  const exit = new Promise<number | null>(resolve => {
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
  const stream = child.stdout[Symbol.asyncIterator]();
  let remaining = Buffer.alloc(0);
  let busy = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    child.stdin.end();
    child.stdout.destroy();
    const cutoff = setTimeout(() => child.kill('SIGKILL'), 1000);
    cutoff.unref();
    child.once('close', () => clearTimeout(cutoff));
  };
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  const closed = exit.then(code => disposed ? undefined
    : code === 4 ? new CaptureCanceledError('UOS desktop was locked')
      : new Error('UOS desktop stream ended'));

  async function read(length: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      if (!remaining.length) {
        const next = await stream.next();
        if (next.done) throw (disposed ? undefined : await closed) ?? new Error('UOS desktop stream ended');
        remaining = next.value;
      }
      const count = Math.min(length - offset, remaining.length);
      remaining.copy(bytes, offset, 0, count);
      offset += count;
      remaining = remaining.subarray(count);
    }
    return bytes;
  }

  async function next(): Promise<UosFrame> {
    if (busy || disposed) throw new Error('UOS desktop source is not accepting frame requests');
    busy = true;
    const timeout = setTimeout(dispose, 5000);
    try {
      child.stdin.write('F');
      const header = await read(12);
      const width = header.readUInt32LE(0), height = header.readUInt32LE(4);
      const fourcc = header.toString('ascii', 8);
      const format = fourcc === 'XR24' || fourcc === 'AR24' ? 'BGRX'
        : fourcc === 'XB24' || fourcc === 'AB24' ? 'RGBX' : null;
      const bytes = width * height * 4;
      if (!format || !width || !height || width > 8192 || height > 8192 || bytes > 64 * 1024 * 1024) {
        throw new Error('Invalid UOS desktop frame');
      }
      return { width, height, format, pixels: await read(bytes) };
    } finally { clearTimeout(timeout); busy = false; }
  }
  try { return { first: await next(), next, closed, dispose }; }
  catch (error) {
    dispose();
    if (error instanceof CaptureCanceledError) throw error;
    return null;
  }
}

export async function captureUosFrame(signal: AbortSignal): Promise<CaptureWindowImage | null> {
  const source = await openUosFrames(signal);
  if (!source) return null;
  try {
    if (signal.aborted) return null;
    const { width, height, format, pixels } = source.first;
    for (let i = 0; i < pixels.length; i += 4) {
      if (format === 'RGBX') [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
      pixels[i + 3] = 255;
    }
    const bitmap = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const image = nativeImage.createFromBitmap(bitmap, { width, height });
    return { dataUrl: image.toDataURL(), width, height,
      selection: { sourceId: UOS_DESKTOP_SOURCE, sourceKind: 'screen', coordinateSpace: 'source',
        sourceSize: { width, height }, crop: { x: 0, y: 0, width, height }, hdrToneMapped: false } };
  } finally { source.dispose(); }
}
