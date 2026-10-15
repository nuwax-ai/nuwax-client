import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ data: {} as Record<string, any>, secure: true }));
vi.mock("../../db", () => ({ readSetting: (key: string) => state.data[key], writeSetting: (key: string, value: any) => { state.data[key] = value; return true; } }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => state.secure, getSelectedStorageBackend: () => "keychain",
  encryptString: (value: string) => Buffer.from("encrypted:" + value),
  decryptString: (value: Buffer) => value.toString().slice(10),
} }));
import { getVlmConfig, setVlmConfig, testVlm, visionProbeImage } from "./vlmDiagnostics";
beforeEach(() => { state.data = {}; state.secure = true; vi.unstubAllGlobals(); });
describe("vision endpoint diagnostics", () => {
  it("migrates legacy plaintext and never returns an existing key to the renderer", () => {
    state.data.step1_config = { unrelated: 3, computerUseVlm: { apiKey: "secret", model: "vision" } };
    expect(getVlmConfig()).toMatchObject({ apiKey: "", hasApiKey: true });
    expect(state.data.step1_config.computerUseVlm.apiKey).toBeUndefined();
    expect(state.data.step1_config.unrelated).toBe(3);
  });
  it("does not save keys when secure storage is unavailable", () => {
    state.secure = false;
    expect(setVlmConfig({ apiKey: "secret" })).toEqual({ success: false, error: "secureStorageUnavailable" });
    expect(state.data).toEqual({});
  });
  it("does not reuse the key when changing providers and supports explicit removal", () => {
    setVlmConfig({ apiKey: "secret", model: "vision" });
    setVlmConfig({ apiKey: "" });
    expect(getVlmConfig().hasApiKey).toBe(true);
    setVlmConfig({ baseUrl: "https://example.com/v1" });
    expect(getVlmConfig().hasApiKey).toBe(false);
    setVlmConfig({ apiKey: "new" });
    setVlmConfig({ clearApiKey: true });
    expect(getVlmConfig().hasApiKey).toBe(false);
  });
  it.each(["http://example.com", "https://user:password@example.com", "https://example.com?token=foo"])("rejects unsafe endpoint %s", (baseUrl) => {
    expect(setVlmConfig({ baseUrl }).success).toBe(false);
  });
  it("sends a generated image and rejects text-only or invalid model responses", async () => {
    setVlmConfig({ apiKey: "secret", model: "vision" });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "red" } }] })));
    vi.stubGlobal("fetch", fetcher);
    expect((await testVlm()).success).toBe(true);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.messages[0].content[1].image_url.url).toBe(visionProbeImage());
    expect(body.messages[0].content[0].text).not.toContain("red");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "I cannot view images" } }] })));
    expect((await testVlm()).error).toBe("visionVerificationFailed");
  });
  it("leaves room for reasoning models and reads GLM boxed answers", async () => {
    setVlmConfig({ apiKey: "secret", model: "glm" });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop",
      message: { content: "<|begin_of_box|>Red<|end_of_box|>", reasoning_content: "The image is uniformly red." } }] })));
    vi.stubGlobal("fetch", fetcher);
    expect((await testVlm()).success).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).max_tokens).toBeGreaterThanOrEqual(1024);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }] })));
    expect((await testVlm()).error).toBe("answerTruncated");
  });
  it("does not echo server content or credentials in errors", async () => {
    setVlmConfig({ apiKey: "secret", model: "vision" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret echoed", { status: 401 })));
    expect(await testVlm()).toEqual({ success: false, error: "HTTP 401" });
  });
});
