import { CUA_MCP_SERVER_ID } from "./constants";

/** Computer Use owns this MCP entry; settings must preserve its lifecycle. */
export function isComputerUseManagedServerId(serverId: string): boolean {
  return serverId.trim().toLowerCase() === CUA_MCP_SERVER_ID;
}
