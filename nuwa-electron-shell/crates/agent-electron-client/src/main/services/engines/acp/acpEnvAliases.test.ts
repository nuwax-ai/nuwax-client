import { describe, expect, it } from "vitest";
import { resolveCodexRoute, takeAliasedEnv } from "./acpEnvAliases";

describe("takeAliasedEnv", () => {
  it("prefers NUWAX_ and removes both spellings", () => {
    const env: Record<string, string> = {
      NUWAX_WIRE_API: "chat",
      CODEX_WIRE_API: "responses",
    };
    expect(takeAliasedEnv(env, "WIRE_API")).toBe("chat");
    expect(env).toEqual({});
  });

  it("falls back to the legacy spelling and still removes it", () => {
    const env: Record<string, string> = { CODEX_PROVIDER_ID: "legacy" };
    expect(takeAliasedEnv(env, "PROVIDER_ID")).toBe("legacy");
    expect(env.CODEX_PROVIDER_ID).toBeUndefined();
    expect(env.NUWAX_PROVIDER_ID).toBeUndefined();
  });

  it("returns undefined when neither spelling is set", () => {
    const env: Record<string, string> = { OTHER: "x" };
    expect(takeAliasedEnv(env, "MODEL")).toBeUndefined();
    expect(env).toEqual({ OTHER: "x" });
  });
});

describe("resolveCodexRoute", () => {
  it("keeps the env URL and pairs it with the env key", () => {
    expect(
      resolveCodexRoute({
        envBaseUrl: "https://env.example/v1",
        envApiKey: "env-key",
        configBaseUrl: "https://config.example/v1",
        configApiKey: "config-key",
      }),
    ).toEqual({
      baseUrl: "https://env.example/v1",
      apiKey: "env-key",
      source: "env",
    });
  });

  it("falls back to config when only config has a URL, and keeps its key", () => {
    expect(
      resolveCodexRoute({
        configBaseUrl: "https://config.example/v1",
        configApiKey: "config-key",
        envApiKey: "env-key",
      }),
    ).toEqual({
      baseUrl: "https://config.example/v1",
      apiKey: "config-key",
      source: "config",
    });
  });

  it("uses the backend route as a pair when nothing else sets a URL", () => {
    expect(
      resolveCodexRoute({
        backendBaseUrl: "https://backend.example/v1",
        backendApiKey: "backend-key",
        envApiKey: "env-key",
      }),
    ).toEqual({
      baseUrl: "https://backend.example/v1",
      apiKey: "backend-key",
      source: "backend",
    });
  });

  it("never borrows a key from another source", () => {
    // The user's environment points at gateway A without a key; the request
    // carries a complete (URL + key) pair for gateway B. Pairing B's key with
    // A's URL would leak the credential, so the complete pair wins.
    expect(
      resolveCodexRoute({
        envBaseUrl: "https://gateway-a.example/v1",
        configBaseUrl: "https://gateway-b.example/v1",
        configApiKey: "gateway-b-key",
      }),
    ).toEqual({
      baseUrl: "https://gateway-b.example/v1",
      apiKey: "gateway-b-key",
      source: "config",
    });

    // Only a URL is available: keep it, but send no key at all instead of a
    // credential that belongs to another endpoint.
    expect(
      resolveCodexRoute({
        envBaseUrl: "https://gateway-a.example/v1",
        configApiKey: "gateway-b-key",
      }),
    ).toEqual({
      baseUrl: "https://gateway-a.example/v1",
      source: "env",
    });
  });

  it("keeps the process env pair separate from the backend env pair", () => {
    // Process env carries gateway A's key; the backend hands down gateway B's
    // URL through agent_config.env. Merging first would present them as one
    // complete route; per-source capture must not pair them.
    expect(
      resolveCodexRoute({
        envApiKey: "gateway-a-key",
        backendEnvBaseUrl: "https://gateway-b.example/v1",
      }),
    ).toEqual({
      baseUrl: "https://gateway-b.example/v1",
      apiKey: undefined,
      source: "backend",
    });
  });

  it("returns only a key when no URL is configured", () => {
    expect(resolveCodexRoute({ configApiKey: "config-key" })).toEqual({
      apiKey: "config-key",
      source: "none",
    });
  });
});
