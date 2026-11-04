export const DSH_IPC = "dsh-runtime:control";
export type DshAction = "status" | "catalog" | "authorize" | "open" | "stop";
export interface DshModel { id: string; name: string; model: string; reason?: string; }
export interface DshStatus { phase: string; error?: string; available: boolean; }
export interface DshReply { ok: boolean; error?: string; status?: DshStatus; models?: DshModel[]; }
export interface DshBridge { control(action: DshAction, modelIds?: string[]): Promise<DshReply>; }
