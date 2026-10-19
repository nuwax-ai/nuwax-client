import { safeStorage } from "electron";
import { deflateSync } from "node:zlib";
import { computerUseHost } from "./ports";

type Config = { baseUrl: string; model: string; apiKey: string };
const KEY = "step1_config";
const DEFAULT_URL = "https://open.bigmodel.cn/api/paas/v4";
type Stored = Partial<Config> & { encryptedKey?: string };
const settings = () => (computerUseHost().readSetting(KEY) ?? {}) as Record<string, unknown>;
const stored = (): Stored => (settings().computerUseVlm ?? {}) as Stored;
function available() {
  return safeStorage.isEncryptionAvailable() &&
    !(process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text");
}
function save(config: Stored) { return computerUseHost().writeSetting(KEY, { ...settings(), computerUseVlm: config }); }
function migrate(): Stored {
  const cfg = stored();
  if (cfg.apiKey && available()) {
    const next = { ...cfg, encryptedKey: safeStorage.encryptString(cfg.apiKey).toString("base64") };
    delete next.apiKey;
    if (!save(next)) throw new Error("databaseNotReady");
    return next;
  }
  return cfg;
}
function validUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
    return url.href.replace(/\/+$/, "");
  } catch { return null; }
}
export function getVlmConfig() {
  const cfg = migrate();
  return { baseUrl: cfg.baseUrl ?? DEFAULT_URL, model: cfg.model ?? "", apiKey: "",
    hasApiKey: !!(cfg.encryptedKey || cfg.apiKey) };
}
export function setVlmConfig(patch: Partial<Config> & { clearApiKey?: boolean }) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { success: false, error: "invalidConfig" };
  const previous = migrate();
  const baseUrl = validUrl(patch.baseUrl ?? previous.baseUrl ?? DEFAULT_URL);
  if (!baseUrl || (patch.model !== undefined && typeof patch.model !== "string") ||
    (patch.apiKey !== undefined && typeof patch.apiKey !== "string")) return { success: false, error: "invalidConfig" };
  const next: Stored = { ...previous, baseUrl, model: (patch.model ?? previous.model ?? "").trim().slice(0, 200) };
  // Never send an existing key to a newly selected endpoint without re-entry.
  if (patch.clearApiKey || baseUrl !== (previous.baseUrl ?? DEFAULT_URL)) { delete next.encryptedKey; delete next.apiKey; }
  if (patch.apiKey) {
    if (!available()) return { success: false, error: "secureStorageUnavailable" };
    next.encryptedKey = safeStorage.encryptString(patch.apiKey).toString("base64");
    delete next.apiKey;
  }
  return save(next) ? { success: true } : { success: false, error: "databaseNotReady" };
}

/** Synthetic red image: no desktop, user files or screenshots leave the machine. */
export function visionProbeImage(): string {
  const chunk = (type: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(16 * 49);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[y * 49 + 1 + x * 3] = 255;
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

export async function testVlm(): Promise<{ success: boolean; error?: string; latencyMs?: number }> {
  const cfg = migrate();
  if (!available()) return { success: false, error: "secureStorageUnavailable" };
  if (!cfg.model || !cfg.encryptedKey) return { success: false, error: "vlmNotConfigured" };
  const baseUrl = validUrl(cfg.baseUrl ?? DEFAULT_URL);
  if (!baseUrl) return { success: false, error: "invalidConfig" };
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const key = safeStorage.decryptString(Buffer.from(cfg.encryptedKey, "base64"));
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", redirect: "error", signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      // Reasoning models spend completion tokens on thinking first; a tight cap leaves the answer empty.
      body: JSON.stringify({ model: cfg.model, max_tokens: 1024, stream: false, messages: [{ role: "user", content: [
        { type: "text", text: "What is the solid background color of this image? Reply with one English color word only." },
        { type: "image_url", image_url: { url: visionProbeImage() } },
      ] }] }),
    });
    if (!response.ok) { await response.body?.cancel(); return { success: false, error: `HTTP ${response.status}` }; }
    const reader = response.body?.getReader();
    if (!reader) return { success: false, error: "invalidResponse" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > 65536) { await reader.cancel(); return { success: false, error: "invalidResponse" }; }
      chunks.push(value.value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const choice = data?.choices?.[0];
    const raw = choice?.message?.content;
    // GLM vision models wrap the final answer in <|begin_of_box|>…<|end_of_box|>.
    const answer = typeof raw === "string" ? raw.replace(/<\|(begin|end)_of_box\|>/g, "") : "";
    const success = /^\s*red[.!]?\s*$/i.test(answer);
    const error = success ? undefined : !answer.trim() && choice?.finish_reason === "length" ? "answerTruncated" : "visionVerificationFailed";
    return { success, ...(error ? { error } : {}), latencyMs: Date.now() - start };
  } catch {
    return { success: false, error: ctrl.signal.aborted ? "timeout" : "requestFailed" };
  } finally { clearTimeout(timer); }
}
