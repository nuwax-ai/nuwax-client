import { DEFAULT_SERVER_HOST } from "@shared/constants";
import { readSetting } from "../db";

export const NUWAX_TICKET_KEY_PREFIX = "nuwax.ticket.";

export function currentBusinessOrigin(): string {
  const raw =
    (readSetting("step1_config") as { serverHost?: string } | null)
      ?.serverHost || DEFAULT_SERVER_HOST;
  return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
}

/** Read only a nonexpired ticket compatible with the configured protocol. */
export function readTicketCookieValue(scopes: string[]): string | null {
  for (const scope of scopes) {
    if (readSetting(`nuwax.ticketSecureHttp.${scope}`)) continue;
    const metadata = readSetting(`nuwax.ticketMeta.${scope}`) as { expirationDate?: number } | null;
    if (metadata?.expirationDate && metadata.expirationDate <= Date.now() / 1000) continue;
    const value = readSetting(`${NUWAX_TICKET_KEY_PREFIX}${scope}`);
    if (typeof value === "string" && value) return value;
  }
  return null;
}
