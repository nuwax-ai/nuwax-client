import { randomBytes, timingSafeEqual } from "node:crypto";

const HEADER = "x-nuwax-native-ticket";
const secret = randomBytes(32).toString("hex");

/** Allow only main-process requests carrying the current ticket past the webRequest gate. */
export function nativeTicketHeaders(ticket: string): Record<string, string> {
  return { Cookie: `ticket=${ticket}`, [HEADER]: secret };
}

/** Consume the private marker before the request leaves Electron. */
export function consumeNativeTicketCapability(headers: Record<string, string>): boolean {
  let supplied: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== HEADER) continue;
    supplied = headers[key];
    delete headers[key];
  }
  return typeof supplied === "string" &&
    Buffer.byteLength(supplied) === Buffer.byteLength(secret) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
}
