import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { THEME_PREVIEW_SETTING } from "@shared/features/themes/contract";

const h = vi.hoisted(() => ({
  product: "nuwax", profile: false, packaged: true, version: "3.1.2-alpha.1",
  store: new Map<string, unknown>(), start: vi.fn(), send: vi.fn(), close: vi.fn(),
}));
vi.mock("@shared/constants", async original => ({
  ...await original<typeof import("@shared/constants")>(),
  get APP_NAME_IDENTIFIER() { return h.product; },
  get IS_DEV_PROFILE() { return h.profile; },
}));
vi.mock("electron", () => ({
  app: { get isPackaged() { return h.packaged; }, getVersion: () => h.version, getAppPath: () => "/app" },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: h.send } }] },
}));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../db", () => ({
  readSetting: (key: string) => h.store.get(key) ?? null,
  writeSetting: (key: string, value: unknown) => { h.store.set(key, value); return true; },
}));
vi.mock("../commercialTicketSession", () => ({
  currentTicket: () => null, ticketEpoch: () => 0, setLoopbackTicketOrigin: vi.fn(),
  mirrorGatewaySetCookies: vi.fn(), advanceTicketEpoch: vi.fn(), abortGatewayTicketMirror: vi.fn(),
}));
vi.mock("../commercialLocalPorts", () => ({ initializeCommercialLocalPorts: () => undefined }));
vi.mock("../localPorts", () => ({ getLocalPortManager: () => undefined }));
vi.mock("../startupPorts", () => ({ getConfiguredPorts: () => ({}) }));
vi.mock("../businessRequestRouting", () => ({ setGatewayRequestRouting: vi.fn() }));
vi.mock("./gateway", () => ({ startLoopbackGateway: h.start, DEFAULT_BACKEND_PREFIXES: ["/api"] }));

let resources: string;
let previousResources: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.resetModules();
  h.product = "nuwax"; h.profile = false; h.packaged = true; h.version = "3.1.2-alpha.1";
  h.store.clear(); h.send.mockClear(); h.close.mockReset();
  h.store.set("step1_config", { nuwaxLoadMode: "direct", serverHost: "https://business.example" });
  h.start.mockReset().mockImplementation(async options => ({ origin: "http://127.0.0.1:46800", mode: options.distDir ? "dist" : "proxy", close: h.close }));
  previousResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  resources = mkdtempSync(path.join(tmpdir(), "nuwax-theme-preview-"));
  mkdirSync(path.join(resources, "nuwax-dist"));
  writeFileSync(path.join(resources, "nuwax-dist/index.html"), "preview");
  Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
  vi.stubEnv("NUWAX_WEBVIEW_ORIGIN", "");
  vi.stubEnv("NUWAX_LOOPBACK", "");
  vi.stubEnv("NUWAX_LOOPBACK_DIST", "");
});
afterEach(async () => {
  await (await import("./index")).stopLoopbackGateway();
  vi.unstubAllEnvs();
  if (previousResources) Object.defineProperty(process, "resourcesPath", previousResources);
  else delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  rmSync(resources, { recursive: true, force: true });
});

it("opts in to the bundled frontend and returns to saved direct mode without rewriting acceleration", async () => {
  const mod = await import("./index");
  const saved = structuredClone(h.store.get("step1_config"));
  expect(mod.getThemePreviewState()).toMatchObject({ available: true, enabled: false });
  expect(mod.isLoopbackGatewayEnabled()).toBe(false);
  await expect(mod.setThemePreviewEnabled(true)).resolves.toBe(true);
  expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ distDir: path.join(resources, "nuwax-dist"), targetOrigin: "https://business.example" }));
  expect(h.store.get("nuwax.loopback")).toMatchObject({ enabled: true, mode: "dist" });
  h.store.set("update_channel", "stable");
  expect(mod.getThemePreviewState().enabled).toBe(true);
  await expect(mod.setThemePreviewEnabled(false)).resolves.toBe(true);
  expect(h.store.get("nuwax.loopback")).toMatchObject({ enabled: false });
  expect(h.store.get("step1_config")).toEqual(saved);
  expect(h.send).toHaveBeenCalledWith("nuwax:loopback-changed", expect.objectContaining({ enabled: false }));
});

it("restores the user's already-enabled acceleration policy when preview is off", async () => {
  h.store.set("step1_config", { nuwaxLoadMode: "gateway", serverHost: "https://business.example" });
  const mod = await import("./index");
  await mod.setThemePreviewEnabled(true);
  await mod.setThemePreviewEnabled(false);
  expect(h.store.get("step1_config")).toMatchObject({ nuwaxLoadMode: "gateway" });
  expect(h.store.get("nuwax.loopback")).toMatchObject({ enabled: true, mode: "dist" });
});

it.each(["3.1.2-beta.1", "3.1.2"])("ignores a saved preview preference and a Dev subscription in %s", async version => {
  h.version = version;
  h.store.set(THEME_PREVIEW_SETTING, true);
  h.store.set("update_channel", "dev");
  const mod = await import("./index");
  expect(mod.getThemePreviewState()).toMatchObject({ available: false, enabled: false });
  expect(mod.isLoopbackGatewayEnabled()).toBe(false);
  await expect(mod.setThemePreviewEnabled(true)).resolves.toBe(false);
  expect(h.start).not.toHaveBeenCalled();
});

it("allows the isolated local Dev profile and preserves explicit source-development ownership", async () => {
  h.packaged = false; h.profile = true;
  const mod = await import("./index");
  expect(mod.getThemePreviewState().available).toBe(true);
  vi.stubEnv("NUWAX_DEV_PROFILE", "1");
  vi.stubEnv("NUWAX_DEV_FRONTEND_MODE", "source");
  expect(mod.getThemePreviewState().sourceForced).toBe(true);
  await expect(mod.setThemePreviewEnabled(true)).resolves.toBe(false);
  expect(h.store.has(THEME_PREVIEW_SETTING)).toBe(false);
});

it("rejects missing resources and rolls back a failed start before permitting a retry", async () => {
  const mod = await import("./index");
  const index = path.join(resources, "nuwax-dist/index.html");
  rmSync(index);
  await expect(mod.setThemePreviewEnabled(true)).resolves.toBe(false);
  expect(h.store.has(THEME_PREVIEW_SETTING)).toBe(false);
  writeFileSync(index, "preview");
  h.start.mockRejectedValueOnce(new Error("EADDRINUSE"));
  await expect(mod.setThemePreviewEnabled(true)).rejects.toThrow("Loopback gateway failed to start");
  expect(h.store.get(THEME_PREVIEW_SETTING)).toBeNull();
  expect(h.store.get("step1_config")).toMatchObject({ nuwaxLoadMode: "direct" });
  expect(h.store.get("nuwax.loopback")).toMatchObject({ enabled: false });
  await expect(mod.setThemePreviewEnabled(true)).resolves.toBe(true);
});
