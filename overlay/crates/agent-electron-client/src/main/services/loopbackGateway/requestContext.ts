/** Main-process-only capability. Never persist or expose through renderer IPC. */
export const GATEWAY_REQUEST_HEADER = "x-nuwax-gateway-request";

export interface GatewayRequestContext {
  origin: string;
  requestSecret: string;
}

let current: GatewayRequestContext | null = null;

export function getGatewayRequestContext(): GatewayRequestContext | null {
  return current;
}

export function setGatewayRequestContext(
  context: GatewayRequestContext | null,
): void {
  current = context;
}
