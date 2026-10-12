import type { IpcRenderer } from "electron";
import { createLocalFilesBridge } from "./local-files";
export function featureNamespaces(ipc: Pick<IpcRenderer, "invoke">) {
  return { localFiles: createLocalFilesBridge(ipc) };
}
