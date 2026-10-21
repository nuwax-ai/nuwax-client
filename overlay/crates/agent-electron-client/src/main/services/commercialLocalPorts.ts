import log from "electron-log";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import { readSetting, writeSetting } from "../db";
import { LocalPortManager, getLocalPortManager, setLocalPortManager } from "./localPorts";

export const AUTOMATIC_PORTS_KEY = "nuwax.localPorts.v1";
export const AUTOMATIC_PORTS_MIGRATED_KEY = "nuwax.automaticPortsMigrated";
const stepPorts = ["agentPort", "fileServerPort", "ttydPort", "gatewayPort", "guiMcpPort", "adminServerPort"];

/** Legacy preferences cannot turn runtime endpoints back into user-controlled ports. */
export function sanitizeCommercialPortSetting(key: string, value: unknown): unknown {
  if (APP_NAME_IDENTIFIER !== "nuwax") return value;
  if (key === "mcp_proxy_port") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (key !== "step1_config" && key !== "agent_config") return value;
  const cleaned = { ...value } as Record<string, unknown>;
  for (const field of key === "step1_config" ? stepPorts : ["backendPort", "proxyPort"]) delete cleaned[field];
  return cleaned;
}

/** Read compatibility for renderers that still consume Step1Config; never persists runtime ports. */
export function projectCommercialPortSetting(key: string, value: unknown): unknown {
  const ports = getLocalPortManager();
  if (APP_NAME_IDENTIFIER !== "nuwax" || !ports || key !== "step1_config") return value;
  const settings = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { ...settings, agentPort: ports.get("agent")?.port ?? 0,
    fileServerPort: ports.get("fileServer")?.port ?? 0, ttydPort: ports.get("ttyd")?.port ?? 0,
    adminServerPort: ports.get("agent")?.port ?? 0, gatewayPort: ports.get("gateway")?.port ?? 0 };
}

export function initializeCommercialLocalPorts(): LocalPortManager | undefined {
  if (APP_NAME_IDENTIFIER !== "nuwax") return undefined;
  const existing = getLocalPortManager();
  if (existing) return existing;
  if (!readSetting(AUTOMATIC_PORTS_MIGRATED_KEY)) {
    for (const key of ["step1_config", "agent_config", "mcp_proxy_port"]) {
      const previous = readSetting(key);
      if (previous != null) writeSetting(key, sanitizeCommercialPortSetting(key, previous));
    }
    writeSetting(AUTOMATIC_PORTS_MIGRATED_KEY, true);
  }
  const saved = readSetting(AUTOMATIC_PORTS_KEY);
  const manager = new LocalPortManager({
    ranges: [[24600, 24999], [20000, 29999]],
    saved: saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {},
    persist: (ports) => writeSetting(AUTOMATIC_PORTS_KEY, ports),
    log: (message) => log.info(message),
  });
  setLocalPortManager(manager);
  return manager;
}
