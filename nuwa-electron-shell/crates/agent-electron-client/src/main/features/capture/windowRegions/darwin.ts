import type { Koffi } from './koffi';
import type { NativeWindowInfo } from './types';

export interface DarwinWindow {
  layer: number;
  alpha: number;
  /** kCGWindowBounds: points, origin at the primary display's top-left, which is Electron's DIP space. */
  bounds: { x: number; y: number; width: number; height: number } | null;
}

/** Layer 0 holds application windows; menu bar, Dock and status items live on higher layers. */
export function selectDarwinWindows(windows: readonly DarwinWindow[]): NativeWindowInfo[] {
  return windows
    .filter((window) => window.layer === 0 && window.alpha > 0 && window.bounds && window.bounds.width > 0 && window.bounds.height > 0)
    .map((window) => ({ bounds: { ...window.bounds! }, space: 'dip' as const }));
}

const kCGWindowListOptionOnScreenOnly = 1 << 0;
const kCGWindowListExcludeDesktopElements = 1 << 4;
const kCFStringEncodingUTF8 = 0x08000100;
const kCFNumberDoubleType = 13;

/** Bounds and layers need no extra permission; window titles and owner names are never read. */
export function createDarwinWindowReader(koffi: Koffi): () => NativeWindowInfo[] {
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const CGRect = koffi.struct('NuwaxCaptureCGRect', { x: 'double', y: 'double', width: 'double', height: 'double' });
  const CGWindowListCopyWindowInfo = cg.func('CGWindowListCopyWindowInfo', 'void *', ['uint32_t', 'uint32_t']);
  const CGRectMakeWithDictionaryRepresentation = cg.func('CGRectMakeWithDictionaryRepresentation', 'bool', ['void *', koffi.out(koffi.pointer(CGRect))]);
  const CFArrayGetCount = cf.func('CFArrayGetCount', 'long', ['void *']);
  const CFArrayGetValueAtIndex = cf.func('CFArrayGetValueAtIndex', 'void *', ['void *', 'long']);
  const CFDictionaryGetValue = cf.func('CFDictionaryGetValue', 'void *', ['void *', 'void *']);
  const CFNumberGetValue = cf.func('CFNumberGetValue', 'bool', ['void *', 'long', koffi.out(koffi.pointer('double'))]);
  const CFStringCreateWithCString = cf.func('CFStringCreateWithCString', 'void *', ['void *', 'str', 'uint32_t']);
  const CFRelease = cf.func('CFRelease', 'void', ['void *']);
  // Dictionary lookup compares string contents, so these equal the framework's key constants; kept for the process lifetime.
  const keys = {
    layer: CFStringCreateWithCString(null, 'kCGWindowLayer', kCFStringEncodingUTF8),
    alpha: CFStringCreateWithCString(null, 'kCGWindowAlpha', kCFStringEncodingUTF8),
    bounds: CFStringCreateWithCString(null, 'kCGWindowBounds', kCFStringEncodingUTF8),
  };
  const number = (dictionary: unknown, key: unknown) => {
    const value = CFDictionaryGetValue(dictionary, key);
    const out = [Number.NaN];
    return value && CFNumberGetValue(value, kCFNumberDoubleType, out) ? out[0] : Number.NaN;
  };
  return () => {
    const list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, 0);
    if (!list) return [];
    try {
      const windows: DarwinWindow[] = [];
      // On-screen windows are listed front to back.
      for (let index = 0, count = Number(CFArrayGetCount(list)); index < count; index++) {
        const dictionary = CFArrayGetValueAtIndex(list, index);
        const boundsDictionary = CFDictionaryGetValue(dictionary, keys.bounds);
        const rect = {} as NonNullable<DarwinWindow['bounds']>;
        const hasBounds = Boolean(boundsDictionary) && CGRectMakeWithDictionaryRepresentation(boundsDictionary, rect);
        windows.push({ layer: number(dictionary, keys.layer), alpha: number(dictionary, keys.alpha), bounds: hasBounds ? rect : null });
      }
      return selectDarwinWindows(windows);
    } finally { CFRelease(list); }
  };
}
