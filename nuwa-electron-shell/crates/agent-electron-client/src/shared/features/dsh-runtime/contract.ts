export const DSH_IPC = "dsh-runtime:control";
export const DSH_LAUNCHER_STATE = "dsh-runtime:launcher-state";
export const DSH_LAUNCHER_OPEN = "dsh-runtime:launcher-open";
export const DSH_PLUGINS_IPC = "dsh-runtime:plugins";
export type DshAction = "status" | "catalog" | "authorize" | "open" | "stop";
export interface DshModel { id: string; name: string; model: string; reason?: string; }
export interface DshStatus { phase: string; error?: string; available: boolean; enabled?: boolean; }
export interface DshReply { ok: boolean; error?: string; status?: DshStatus; models?: DshModel[]; }
export type DshPluginOperation = "list" | "install" | "enable" | "disable" | "remove" | "configure";
export interface DshPluginBundle { name: string; version?: string; installed: boolean; enabled: boolean; protected: boolean; removable: boolean; readOnlyReason?: string; }
export interface DshPluginConfiguration { ns: string; value: Record<string, unknown>; revision: number; }
export interface DshPluginReply { ok: boolean; error?: string; value?: {
  bundles?: DshPluginBundle[]; configuration?: DshPluginConfiguration[]; application?: string; restartReason?: string;
}; }
export interface DshBridge {
  control(action: DshAction, modelIds?: string[]): Promise<DshReply>;
  plugins(operation: DshPluginOperation, input?: { target?: string; patch?: Record<string, unknown>; expectedRevision?: number }): Promise<DshPluginReply>;
}
