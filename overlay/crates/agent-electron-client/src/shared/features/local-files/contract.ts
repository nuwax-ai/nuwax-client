export const LOCAL_FILES_SCHEME = 'nuwax-local';
export const LOCAL_FILES_API_VERSION = 2;
export const LOCAL_FILES_ENABLED_SETTING = 'features.local-files.enabled';
export const LOCAL_FILES_ENABLED_BY_DEFAULT = true;
export const LOCAL_FILES_IPC = {
  PICK_DIRECTORY: 'localFiles:pickDirectory', GET_CAPABILITIES: 'localFiles:getCapabilities',
  RESOLVE_CONTEXT: 'localFiles:resolveContext', RELEASE_CONTEXT: 'localFiles:releaseContext',
  LIST_FILES: 'localFiles:listFiles', SEARCH_FILES: 'localFiles:searchFiles', STAT: 'localFiles:stat',
  PREPARE_PREVIEW: 'localFiles:preparePreview', RELEASE_PREVIEW: 'localFiles:releasePreview',
  OPEN_PATH: 'localFiles:openPath', REVEAL_IN_FOLDER: 'localFiles:revealInFolder',
  UPDATE_FILES: 'localFiles:updateFiles',
  SAVE_FILE: 'localFiles:saveFile', EXPORT_WORKSPACE: 'localFiles:exportWorkspace', CANCEL: 'localFiles:cancel',
} as const;
export type { HostLocalFilesBridge, LocalFilesErrorCode, LocalFilesResult, LocalFilesCapabilities,
  LocalFilesContextInput, LocalFilesContext, LocalFileTarget, LocalFilesListOptions, LocalFilesSearchOptions,
  LocalFileEntry, LocalFilesList, LocalFileMetadata, LocalFilePreview, LocalFileSaveOptions, LocalFileSaved, LocalFileChange,
} from '@shared/types/hostBridge';

/** Grant hosts are credentials; never log them or pass them as an HTTP referrer. */
export function redactLocalFileUrl(value: string): string {
  return value.replace(/nuwax-local:\/\/[^/\s"']+/gi, 'nuwax-local://[redacted]');
}

/** A preview and all its child frames must never borrow platform credentials. */
export function isLocalFileRequestSource(details: {
  referrer?: string;
  frame?: { url?: string; parent?: unknown; detached?: boolean } | null;
}): boolean {
  if (/^nuwax-local:/i.test(details.referrer ?? '')) return true;
  let frame = details.frame;
  const seen = new Set<unknown>();
  try {
    while (frame && !seen.has(frame)) {
      seen.add(frame);
      if (/^nuwax-local:/i.test(frame.url ?? '')) return true;
      frame = frame.parent as typeof frame;
    }
  } catch { return true; }
  return false;
}
