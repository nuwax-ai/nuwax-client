import { describe, it, expect } from "vitest";
import {
  APP_DISPLAY_NAME,
  APP_NAME_IDENTIFIER,
  APP_DATA_DIR_NAME,
  DEFAULT_MCP_PROXY_PORT,
  DEFAULT_FILE_SERVER_PORT,
  DEFAULT_AGENT_RUNNER_PORT,
  DEFAULT_LANPROXY_PORT,
  DEFAULT_DEV_SERVER_PORT,
  DEFAULT_AI_ENGINE,
  isAgentEngineType,
  normalizeAgentEngine,
  normalizeOptionalPort,
  DEFAULT_SSE_RETRY_DELAY,
  DEFAULT_SSE_MAX_RETRY_DELAY,
  CLEANUP_TIMEOUT,
  PROCESS_KILL_ESCALATION_TIMEOUT,
  ACP_ABORT_TIMEOUT,
  ENGINE_DESTROY_TIMEOUT,
  DEPS_SYNC_TIMEOUT,
  STORAGE_KEYS,
  AUTH_KEYS,
} from "./constants";

describe("Constants", () => {
  describe("App Identity", () => {
    it("should have consistent app name", () => {
      expect(APP_DISPLAY_NAME).toBe("女娲 Nuwax");
      expect(APP_NAME_IDENTIFIER).toBe("nuwaclaw");
    });

    it("should have app data dir name with dot prefix", () => {
      expect(APP_DATA_DIR_NAME).toBe(".nuwaclaw");
    });
  });

  describe("Port Configuration", () => {
    it("should have valid port numbers", () => {
      expect(DEFAULT_MCP_PROXY_PORT).toBeGreaterThan(0);
      expect(DEFAULT_MCP_PROXY_PORT).toBeLessThan(65536);
      expect(DEFAULT_FILE_SERVER_PORT).toBe(60005);
      expect(DEFAULT_AGENT_RUNNER_PORT).toBe(60006);
      expect(DEFAULT_LANPROXY_PORT).toBe(60002);
      expect(DEFAULT_DEV_SERVER_PORT).toBe(60173);
    });

    it("should have non-overlapping ports", () => {
      const ports = [
        DEFAULT_MCP_PROXY_PORT,
        DEFAULT_FILE_SERVER_PORT,
        DEFAULT_AGENT_RUNNER_PORT,
        DEFAULT_LANPROXY_PORT,
        DEFAULT_DEV_SERVER_PORT,
      ];
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
    });
  });

  describe("AI Configuration", () => {
    it("should normalize legacy or invalid AI engine values", () => {
      expect(isAgentEngineType("claude-code")).toBe(true);
      expect(isAgentEngineType("nuwaxcode")).toBe(true);
      expect(isAgentEngineType("codex-cli")).toBe(true);
      expect(normalizeAgentEngine("nuwaxcode")).toBe("nuwaxcode");
      expect(normalizeAgentEngine("unknown-engine")).toBe(DEFAULT_AI_ENGINE);
      expect(normalizeAgentEngine(undefined)).toBe(DEFAULT_AI_ENGINE);
    });

    it("should normalize optional port values", () => {
      expect(normalizeOptionalPort(60001)).toBe(60001);
      expect(normalizeOptionalPort("60001")).toBe(60001);
      expect(normalizeOptionalPort("")).toBeUndefined();
      expect(normalizeOptionalPort("abc")).toBeUndefined();
      expect(normalizeOptionalPort(0)).toBeUndefined();
      expect(normalizeOptionalPort(65536)).toBeUndefined();
    });
  });

  describe("Timeout Configuration", () => {
    it("should have max retry delay greater than initial retry delay", () => {
      expect(DEFAULT_SSE_MAX_RETRY_DELAY).toBeGreaterThanOrEqual(
        DEFAULT_SSE_RETRY_DELAY,
      );
    });

    it("should have process kill escalation shorter than cleanup timeout", () => {
      expect(PROCESS_KILL_ESCALATION_TIMEOUT).toBeLessThan(CLEANUP_TIMEOUT);
    });

    it("should have ACP abort timeout shorter than engine destroy timeout", () => {
      expect(ACP_ABORT_TIMEOUT).toBeLessThanOrEqual(ENGINE_DESTROY_TIMEOUT);
    });

    it("should have deps sync timeout as the largest timeout", () => {
      expect(DEPS_SYNC_TIMEOUT).toBeGreaterThan(ENGINE_DESTROY_TIMEOUT);
      expect(DEPS_SYNC_TIMEOUT).toBeGreaterThan(CLEANUP_TIMEOUT);
    });
  });

  describe("Storage Keys", () => {
    it("should have all required storage keys", () => {
      expect(STORAGE_KEYS.SETUP_STATE).toBe("setup_state");
      expect(STORAGE_KEYS.STEP1_CONFIG).toBe("step1_config");
      expect(STORAGE_KEYS.AUTH_USER).toBe("auth_user");
      expect(STORAGE_KEYS.API_KEY).toBe("anthropic_api_key");
    });

    it("should have auth keys", () => {
      expect(AUTH_KEYS.USERNAME).toBe("auth.username");
      expect(AUTH_KEYS.PASSWORD).toBe("auth.password");
      expect(AUTH_KEYS.SAVED_KEY).toBe("auth.saved_key");
    });
  });
});
