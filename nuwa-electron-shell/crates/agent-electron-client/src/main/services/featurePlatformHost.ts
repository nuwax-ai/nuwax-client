import { net as electronNet } from "electron";
import { getLocalPortManager, type LocalPortManager } from "./localPorts";
import { initializeCommercialLocalPorts } from "./commercialLocalPorts";
import { readSetting } from "../db";
import { currentTicket, ticketEpoch } from "./commercialTicketSession";
import { currentBusinessOrigin } from "./commercialSessionScope";
import { nativeTicketHeaders } from "./nativeTicketCapability";
import { getAppEnv } from "./system/dependencies";
import type { FeaturePlatform, FeatureAccountScope } from "../features";

/** Main-owned platform calls; no ticket or provider key crosses the feature bridge. */
export function createFeaturePlatformHost(): FeaturePlatform {
  const allocated = new Map<number, LocalPortManager>();
  const scope = (): FeatureAccountScope | null => {
    const accountId = readSetting("auth.account_id");
    return currentTicket() && typeof accountId === "string" && accountId
      ? { accountId, origin: currentBusinessOrigin(), epoch: ticketEpoch() } : null;
  };
  const matches = (expected: FeatureAccountScope) => {
    const actual = scope();
    return actual?.accountId === expected.accountId && actual.origin === expected.origin && actual.epoch === expected.epoch;
  };
  return {
    scope,
    async request(expected, route, method = "GET", data) {
      if (!matches(expected) || !/^\/api\/(model\/my\?tab=(System|Space)|tenant\/config|user\/api-key\/(list|create|update))$/.test(route))
        throw new Error("Platform request is not authorized");
      const ticket = currentTicket();
      if (!ticket) throw new Error("Login required");
      const response = await electronNet.fetch(new URL(route, expected.origin).href, {
        method, redirect: "error", headers: { "Content-Type": "application/json", "x-client-type": "nuwax", ...nativeTicketHeaders(ticket) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(20000),
      });
      if (!matches(expected)) throw new Error("Account changed");
      if (!response.ok) throw new Error(`Platform request failed (${response.status})`);
      const body = await response.json() as { success?: boolean; data?: unknown };
      if (!matches(expected)) throw new Error("Account changed");
      if (body.success !== true) throw new Error("Platform request was refused");
      return body.data;
    },
    environment() {
      const source = getAppEnv();
      const names = ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "LANG", "LC_ALL",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
        "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
      return Object.fromEntries(names.flatMap(name => typeof source[name] === "string" ? [[name, source[name]!]] : []));
    },
    async allocatePort() {
      const ports = getLocalPortManager() ?? initializeCommercialLocalPorts();
      if (!ports) throw new Error("Commercial port management unavailable");
      const port = await ports.allocatePrivate();
      allocated.set(port, ports);
      return port;
    },
    async releasePort(port) {
      const ports = allocated.get(port);
      allocated.delete(port);
      await ports?.releasePrivate(port);
    },
  };
}
