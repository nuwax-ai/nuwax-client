export const WORKBENCH_IPC = "workbench:control";
export const WORKBENCH_OPEN_IPC = "workbench:open";
export const WORKBENCH_MCP = "nuwax-workbench";

export interface WorkbenchState {
  available: boolean;
  agentAccess: boolean;
  phase: string;
  error?: string;
}

export interface WorkbenchReply {
  ok: boolean;
  error?: string;
  state?: WorkbenchState;
}

export interface WorkbenchBridge {
  control(action: "state" | "access" | "stop", enabled?: boolean): Promise<WorkbenchReply>;
}
