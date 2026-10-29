import type { HostBridgeContract, HostCapability } from './types/hostBridge';

export const CAN_USE_IPC = 'host:canUse';

type Namespace = Exclude<keyof HostBridgeContract, 'canUse'>;
type MethodLists = { [K in Namespace]-?: readonly Extract<keyof NonNullable<HostBridgeContract[K]>, string>[] };

/** 公开能力白名单；退休的 token 接口即使存在也不声明为可用。 */
export const HOST_CAPABILITY_METHODS = {
  perf: ['enabled', 'mark', 'markOnce'],
  auth: ['getContext', 'syncSession', 'beginLogin', 'clear', 'configureServerHost'],
  native: ['saveImage', 'saveFile', 'openWindow', 'openClientSettings'],
  localFiles: ['pickDirectory', 'getCapabilities', 'resolveContext', 'releaseContext', 'listFiles', 'searchFiles',
    'stat', 'preparePreview', 'releasePreview', 'openPath', 'revealInFolder', 'updateFiles', 'beginTransfer', 'writeTransferChunk', 'commitTransfer', 'saveFile', 'exportWorkspace', 'cancel'],
  updater: ['getState', 'check', 'download', 'install'],
  events: ['onHostCommand'],
  theme: ['syncTheme'],
  layout: ['setNewTaskAvailable', 'setSecondMenuAvailable', 'setSecondMenuCollapsed', 'setTitlebarDragRegions'],
  titlebar: ['beginDrag', 'endDrag', 'toggleMaximize'],
  i18n: ['syncLang'],
  meta: ['syncWebInfo'],
  host: ['getProduct'],
  im: ['setNotificationEnabled', 'getUnreadSnapshot', 'onUnreadChanged'],
  capture: ['getCapabilities', 'screenshot', 'record', 'cancel', 'onStateChange', 'readChunk', 'release', 'copy'],
  browser: ['getCapabilities'],
} as const satisfies MethodLists;

const VARIANTS = {
  'capture.screenshot.png': 'screenshot',
  'capture.screenshot.jpeg': 'screenshot',
  'capture.screenshot.webp': 'screenshot',
  'capture.record.mp4': 'record',
  'capture.record.webm': 'record',
  'capture.record.gif': 'record',
  'capture.copy.image': 'copy',
  'capture.copy.file': 'copy',
} as const satisfies Partial<Record<HostCapability, string>>;

export function resolveHostCapability(name: unknown): { namespace: Namespace; methods: readonly string[]; variant?: string } | null {
  if (typeof name !== 'string') return null;
  if (Object.hasOwn(VARIANTS, name)) {
    return { namespace: 'capture', methods: [VARIANTS[name as keyof typeof VARIANTS]], variant: name.split('.')[2] };
  }
  const [namespace, method, extra] = name.split('.');
  if (extra !== undefined || !Object.hasOwn(HOST_CAPABILITY_METHODS, namespace)) return null;
  const methods: readonly string[] = HOST_CAPABILITY_METHODS[namespace as Namespace];
  if (method !== undefined && !methods.includes(method)) return null;
  return { namespace: namespace as Namespace, methods: method === undefined ? methods : [method] };
}
