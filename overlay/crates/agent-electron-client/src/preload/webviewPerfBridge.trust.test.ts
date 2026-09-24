import { afterEach, describe, expect, it, vi } from "vitest";

const expose = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { on: vi.fn(), send: vi.fn(), invoke: vi.fn() },
}));

const addedArgs: string[] = [];
afterEach(() => {
  for (const arg of addedArgs) {
    const index = process.argv.indexOf(arg);
    if (index >= 0) process.argv.splice(index, 1);
  }
  addedArgs.length = 0;
  vi.unstubAllGlobals();
  expose.mockClear();
});

async function loadAt(origin: string) {
  vi.resetModules();
  const product = "--nuwax-host-product=nuwax";
  const origins = `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify(["https://business.example"]))}`;
  process.argv.push(product, origins);
  addedArgs.push(product, origins);
  vi.stubGlobal("window", { location: { origin }, addEventListener: vi.fn() });
  await import("./webviewPerfBridge");
}

describe("commercial guest preload origin guard", () => {
  it("exposes the bridge on the admitted business origin", async () => {
    await loadAt("https://business.example");
    expect(expose).toHaveBeenCalledWith("NuwaClawBridge", expect.any(Object));
  });

  it("does not expose any bridge after cross-origin navigation", async () => {
    await loadAt("https://external.example");
    expect(expose).not.toHaveBeenCalled();
  });
});
