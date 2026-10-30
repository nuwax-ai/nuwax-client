import * as os from "os";
import { IS_DEV_PROFILE } from "@shared/constants";

/** Registration and local display must name the same development instance. */
export function getComputerName(development = IS_DEV_PROFILE): string {
  const name = os.hostname().replace(/\.local$/i, "").trim();
  return development ? `${name} Dev` : name;
}

/** Preserve the installed client's raw-hostname contract. */
export function getClientHostname(): string {
  return IS_DEV_PROFILE ? getComputerName() : os.hostname();
}
