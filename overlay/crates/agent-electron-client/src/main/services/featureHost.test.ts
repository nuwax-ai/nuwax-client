import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ sessions: vi.fn() }));
vi.mock("./engines/unifiedAgent", () => ({ agentService: { listAllSessionsDetailed: h.sessions } }));
vi.mock("../db", () => ({ getDb: () => null }));
vi.mock("./system/binaryLocator", () => ({ getNodeBinPathWithFallback: () => null }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
import { createFeatureAgentHost } from "./featureHost";
beforeEach(() => h.sessions.mockReset());
describe("host-owned conversation metadata", () => {
  it("resolves the native session's projectId without falling back to another active session", () => {
    h.sessions.mockReturnValue([{ id: "native-A", projectId: "101" }, { id: "native-B", projectId: "202" }]);
    const host = createFeatureAgentHost();
    expect(host.resolveConversationId("native-A")).toBe("101");
    expect(host.resolveConversationId("missing")).toBeNull();
  });
  it("hides ambiguous or incomplete ownership across engines", () => {
    const host = createFeatureAgentHost();
    h.sessions.mockReturnValue([{ id: "same", projectId: "101" }, { id: "same", projectId: "202" }]);
    expect(host.resolveConversationId("same")).toBeNull();
    h.sessions.mockReturnValue([{ id: "same", projectId: "101" }, { id: "same" }]);
    expect(host.resolveConversationId("same")).toBeNull();
  });
});
