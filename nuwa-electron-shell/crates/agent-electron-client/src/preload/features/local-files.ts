import type { IpcRenderer } from "electron";
import { LOCAL_FILES_API_VERSION, LOCAL_FILES_IPC as CH, type HostLocalFilesBridge } from "@shared/features/local-files/contract";

/** canUse 的 localFiles 侧探测：特性可用性 + 异步后二次授权。 */
export async function localFilesCapabilityProbe(
  capability: { methods: readonly string[]; variant?: string },
  name: string,
  bridge: { localFiles?: HostLocalFilesBridge },
  authorize: (name: string) => Promise<boolean>,
): Promise<boolean> {
  const caps = await bridge.localFiles?.getCapabilities?.();
  return caps?.available === true && await authorize(name) === true;
}

export function createLocalFilesBridge(ipc: Pick<IpcRenderer, "invoke">): HostLocalFilesBridge {
  return {
    pickDirectory: () => ipc.invoke(CH.PICK_DIRECTORY),
    getCapabilities: () => ipc.invoke(CH.GET_CAPABILITIES).catch(() => ({ apiVersion: LOCAL_FILES_API_VERSION, available: false })),
    resolveContext: input => ipc.invoke(CH.RESOLVE_CONTEXT, input),
    releaseContext: id => ipc.invoke(CH.RELEASE_CONTEXT, id).catch(() => undefined),
    listFiles: (id, options) => ipc.invoke(CH.LIST_FILES, id, options),
    searchFiles: (id, options) => ipc.invoke(CH.SEARCH_FILES, id, options),
    stat: target => ipc.invoke(CH.STAT, target),
    preparePreview: target => ipc.invoke(CH.PREPARE_PREVIEW, target),
    releasePreview: id => ipc.invoke(CH.RELEASE_PREVIEW, id).catch(() => undefined),
    openPath: target => ipc.invoke(CH.OPEN_PATH, target),
    revealInFolder: target => ipc.invoke(CH.REVEAL_IN_FOLDER, target),
    updateFiles: (id, changes) => ipc.invoke(CH.UPDATE_FILES, id, changes),
    beginTransfer: (id, input) => ipc.invoke(CH.BEGIN_TRANSFER, id, input),
    writeTransferChunk: (id, index, offset, bytes) => ipc.invoke(CH.WRITE_TRANSFER_CHUNK, id, index, offset, bytes),
    commitTransfer: id => ipc.invoke(CH.COMMIT_TRANSFER, id),
    saveFile: (target, options) => ipc.invoke(CH.SAVE_FILE, target, options),
    exportWorkspace: (id, options) => ipc.invoke(CH.EXPORT_WORKSPACE, id, options),
    cancel: id => ipc.invoke(CH.CANCEL, id).catch(() => undefined),
  };
}
