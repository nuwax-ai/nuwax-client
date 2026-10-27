import type { DistHandshakeView } from "@shared/types/distVersionHandshake";
import type { DistHandshake } from "./distVersionHandshake";

interface GatewayState {
  running: boolean;
  origin?: string;
  mode?: "dist" | "proxy";
}

/** Recheck the authoritative context after await; renderer requests cannot select a backend. */
export function createDistHandshakeReader(deps: {
  handshake: DistHandshake;
  backendOrigin: () => string;
  sessionEpoch: () => number;
  gatewayStatus: () => GatewayState;
}) {
  const unavailable = (): DistHandshakeView => ({
    backendOrigin: "", bundled: null, cloud: null, relation: "unknown", checkedAt: null, gateway: null,
  });
  return async (force = false): Promise<DistHandshakeView> => {
    const origin = deps.backendOrigin(), epoch = deps.sessionEpoch();
    const gateway = deps.gatewayStatus();
    try {
      // A configuration mistake must not compare the bundle with itself.
      if (gateway.running && gateway.origin && new URL(origin).origin === new URL(gateway.origin).origin) return unavailable();
    } catch { return unavailable(); }
    const result = await deps.handshake.getSnapshot(origin, { force: force === true, scope: epoch });
    if (origin !== deps.backendOrigin() || epoch !== deps.sessionEpoch()) {
      return unavailable();
    }
    const status = deps.gatewayStatus();
    return {
      ...result,
      gateway: status.running && status.origin && status.mode
        ? { origin: status.origin, mode: status.mode } : null,
    };
  };
}
