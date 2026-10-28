/** Private shell diagnostic. Business WebViews do not receive this bridge. */
export interface DistBuildVersion {
  name: string;
  version: string;
  gitHash?: string;
}

export type DistVersionRelation =
  | "match"
  | "different"
  | "behind"
  | "ahead"
  | "unknown";

export interface DistHandshakeSnapshot {
  backendOrigin: string;
  bundled: DistBuildVersion | null;
  cloud: DistBuildVersion | null;
  relation: DistVersionRelation;
  checkedAt: number | null;
}

export interface DistHandshakeView extends DistHandshakeSnapshot {
  gateway: { origin: string; mode: "dist" | "proxy" } | null;
}
